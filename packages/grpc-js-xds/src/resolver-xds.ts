/*
 * Copyright 2019 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as protoLoader from '@grpc/proto-loader';

import { RE2 } from 're2-wasm';

import { getSingletonXdsClient, XdsClient } from './xds-client';
import { StatusObject, status, logVerbosity, Metadata, experimental, ChannelOptions } from '@grpc/grpc-js';
import Resolver = experimental.Resolver;
import GrpcUri = experimental.GrpcUri;
import ResolverListener = experimental.ResolverListener;
import uriToString = experimental.uriToString;
import ServiceConfig = experimental.ServiceConfig;
import registerResolver = experimental.registerResolver;
import { Listener__Output } from './generated/envoy/api/v2/Listener';
import { Watcher } from './xds-stream-state/xds-stream-state';
import { RouteConfiguration__Output } from './generated/envoy/api/v2/RouteConfiguration';
import { HttpConnectionManager__Output } from './generated/envoy/config/filter/network/http_connection_manager/v2/HttpConnectionManager';
import { GRPC_XDS_EXPERIMENTAL_ROUTING } from './environment';
import { CdsLoadBalancingConfig } from './load-balancer-cds';
import { VirtualHost__Output } from './generated/envoy/api/v2/route/VirtualHost';
import { RouteMatch__Output } from './generated/envoy/api/v2/route/RouteMatch';
import { HeaderMatcher__Output } from './generated/envoy/api/v2/route/HeaderMatcher';
import ConfigSelector = experimental.ConfigSelector;
import LoadBalancingConfig = experimental.LoadBalancingConfig;
import { XdsClusterManagerLoadBalancingConfig } from './load-balancer-xds-cluster-manager';

const TRACER_NAME = 'xds_resolver';

function trace(text: string): void {
  experimental.trace(logVerbosity.DEBUG, TRACER_NAME, text);
}

// Better match type has smaller value.
enum MatchType {
  EXACT_MATCH,
  SUFFIX_MATCH,
  PREFIX_MATCH,
  UNIVERSE_MATCH,
  INVALID_MATCH,
};

function domainPatternMatchType(domainPattern: string): MatchType {
  if (domainPattern.length === 0) {
    return MatchType.INVALID_MATCH;
  }
  if (domainPattern.indexOf('*') < 0) {
    return MatchType.EXACT_MATCH;
  }
  if (domainPattern === '*') {
    return MatchType.UNIVERSE_MATCH;
  }
  if (domainPattern.startsWith('*')) {
    return MatchType.SUFFIX_MATCH;
  }
  if (domainPattern.endsWith('*')) {
    return MatchType.PREFIX_MATCH;
  }
  return MatchType.INVALID_MATCH;
}

function domainMatch(matchType: MatchType, domainPattern: string, expectedHostName: string) {
  switch (matchType) {
    case MatchType.EXACT_MATCH:
      return expectedHostName === domainPattern;
    case MatchType.SUFFIX_MATCH:
      return expectedHostName.endsWith(domainPattern.substring(1));
    case MatchType.PREFIX_MATCH:
      return expectedHostName.startsWith(domainPattern.substring(0, domainPattern.length - 1));
    case MatchType.UNIVERSE_MATCH:
      return true;
    case MatchType.INVALID_MATCH:
      return false;
  }
}

function findVirtualHostForDomain(virutalHostList: VirtualHost__Output[], domain: string): VirtualHost__Output | null {
  let targetVhost: VirtualHost__Output | null = null;
  let bestMatchType: MatchType = MatchType.INVALID_MATCH;
  let longestMatch = 0;
  for (const virtualHost of virutalHostList) {
    for (const domainPattern of virtualHost.domains) {
      const matchType = domainPatternMatchType(domainPattern);
      // If we already have a match of a better type, skip this one
      if (matchType > bestMatchType) {
        continue;
      }
      // If we already have a longer match of the same type, skip this one
      if (matchType === bestMatchType && domainPattern.length <= longestMatch) {
        continue;
      }
      if (domainMatch(matchType, domainPattern, domain)) {
        targetVhost = virtualHost;
        bestMatchType = matchType;
        longestMatch = domainPattern.length;
      }
      if (bestMatchType === MatchType.EXACT_MATCH) {
        break;
      }
    }
    if (bestMatchType === MatchType.EXACT_MATCH) {
      break;
    }
  }
  return targetVhost;
}

interface Matcher {
  (methodName: string, metadata: Metadata): boolean;
}

const numberRegex = new RE2(/^-?\d+$/u);

function getPredicateForHeaderMatcher(headerMatch: HeaderMatcher__Output): Matcher {
  let valueChecker: (value: string) => boolean;
  switch (headerMatch.header_match_specifier) {
    case 'exact_match':
      valueChecker = value => value === headerMatch.exact_match;
      break;
    case 'safe_regex_match':
      const regex = new RE2(`^${headerMatch.safe_regex_match}$`, 'u');
      valueChecker = value => regex.test(value);
      break;
    case 'range_match':
      const start = BigInt(headerMatch.range_match!.start);
      const end = BigInt(headerMatch.range_match!.end);
      valueChecker = value => {
        if (!numberRegex.test(value)) {
          return false;
        }
        const numberValue = BigInt(value);
        return start <= numberValue && numberValue < end;
      }
      break;
    case 'present_match':
      valueChecker = value => true;
      break;
    case 'prefix_match':
      valueChecker = value => value.startsWith(headerMatch.prefix_match!);
      break;
    case 'suffix_match':
      valueChecker = value => value.endsWith(headerMatch.suffix_match!);
      break;
    default:
      // Should be prevented by validation rules
      return (methodName, metadata) => false;
  }
  const headerMatcher: Matcher = (methodName, metadata) => {
    if (headerMatch.name.endsWith('-bin')) {
      return false;
    }
    let value: string;
    if (headerMatch.name === 'content-type') {
      value = 'application/grpc';
    } else {
      const valueArray = metadata.get(headerMatch.name);
      if (valueArray.length === 0) {
        return false;
      } else {
        value = valueArray.join(',');
      }
    }
    return valueChecker(value);
  }
  if (headerMatch.invert_match) {
    return (methodName, metadata) => !headerMatcher(methodName, metadata);
  } else {
    return headerMatcher;
  }
}

const RUNTIME_FRACTION_DENOMINATOR_VALUES = {
  HUNDRED: 100,
  TEN_THOUSAND: 10_000,
  MILLION: 1_000_000
}

function getPredicateForMatcher(routeMatch: RouteMatch__Output): Matcher {
  let pathMatcher: Matcher;
  switch (routeMatch.path_specifier) {
    case 'prefix':
      if (routeMatch.case_sensitive?.value === false) {
        const prefix = routeMatch.prefix!.toLowerCase();
        pathMatcher = (methodName, metadata) => (methodName.toLowerCase().startsWith(prefix));
      } else {
        const prefix = routeMatch.prefix!;
        pathMatcher = (methodName, metadata) => (methodName.startsWith(prefix));
      }
      break;
    case 'path':
      if (routeMatch.case_sensitive?.value === false) {
        const path = routeMatch.path!.toLowerCase();
        pathMatcher = (methodName, metadata) => (methodName.toLowerCase() === path);
      } else {
        const path = routeMatch.path!;
        pathMatcher = (methodName, metadata) => (methodName === path);
      }
      break;
    case 'safe_regex':
      const flags = routeMatch.case_sensitive?.value === false ? 'ui' : 'u';
      const regex = new RE2(`^${routeMatch.safe_regex!.regex!}$`, flags);
      pathMatcher = (methodName, metadata) => (regex.test(methodName));
      break;
    default:
      // Should be prevented by validation rules
      return (methodName, metadata) => false;
  }
  const headerMatchers: Matcher[] = routeMatch.headers.map(getPredicateForHeaderMatcher);
  let runtimeFractionHandler: () => boolean;
  if (!routeMatch.runtime_fraction?.default_value) {
    runtimeFractionHandler = () => true;
  } else {
    const numerator = routeMatch.runtime_fraction.default_value.numerator;
    const denominator = RUNTIME_FRACTION_DENOMINATOR_VALUES[routeMatch.runtime_fraction.default_value.denominator];
    runtimeFractionHandler = () => {
      const randomNumber = Math.random() * denominator;
      return randomNumber < numerator;
    }
  }
  return (methodName, metadata) => pathMatcher(methodName, metadata) && headerMatchers.every(matcher => matcher(methodName, metadata)) && runtimeFractionHandler();
}

class XdsResolver implements Resolver {
  private hasReportedSuccess = false;

  private ldsWatcher: Watcher<Listener__Output>;
  private rdsWatcher: Watcher<RouteConfiguration__Output>
  private isLdsWatcherActive = false;
  /**
   * The latest route config name from an LDS response. The RDS watcher is
   * actively watching that name if and only if this is not null.
   */
  private latestRouteConfigName: string | null = null;

  private latestRouteConfig: RouteConfiguration__Output | null = null;

  private clusterRefcounts = new Map<string, {inLastConfig: boolean, refCount: number}>();

  constructor(
    private target: GrpcUri,
    private listener: ResolverListener,
    private channelOptions: ChannelOptions
  ) {
    this.ldsWatcher = {
      onValidUpdate: (update: Listener__Output) => {
        const httpConnectionManager = update.api_listener!
            .api_listener as protoLoader.AnyExtension &
            HttpConnectionManager__Output;
        switch (httpConnectionManager.route_specifier) {
          case 'rds': {
            const routeConfigName = httpConnectionManager.rds!.route_config_name;
            if (this.latestRouteConfigName !== routeConfigName) {
              if (this.latestRouteConfigName !== null) {
                getSingletonXdsClient().removeRouteWatcher(this.latestRouteConfigName, this.rdsWatcher);
              }
              getSingletonXdsClient().addRouteWatcher(httpConnectionManager.rds!.route_config_name, this.rdsWatcher);
              this.latestRouteConfigName = routeConfigName;
            }
            break;
          }
          case 'route_config':
            if (this.latestRouteConfigName) {
              getSingletonXdsClient().removeRouteWatcher(this.latestRouteConfigName, this.rdsWatcher);
            }
            this.handleRouteConfig(httpConnectionManager.route_config!);
            break;
          default:
            // This is prevented by the validation rules
        }
      },
      onTransientError: (error: StatusObject) => {
        /* A transient error only needs to bubble up as a failure if we have
         * not already provided a ServiceConfig for the upper layer to use */
        if (!this.hasReportedSuccess) {
          trace('Resolution error for target ' + uriToString(this.target) + ' due to xDS client transient error ' + error.details);
          this.reportResolutionError(error.details);
        }
      },
      onResourceDoesNotExist: () => {
        trace('Resolution error for target ' + uriToString(this.target) + ': LDS resource does not exist');
        this.reportResolutionError(`Listener ${this.target} does not exist`);
      }
    };
    this.rdsWatcher = {
      onValidUpdate: (update: RouteConfiguration__Output) => {
        this.handleRouteConfig(update);
      },
      onTransientError: (error: StatusObject) => {
        /* A transient error only needs to bubble up as a failure if we have
         * not already provided a ServiceConfig for the upper layer to use */
        if (!this.hasReportedSuccess) {
          trace('Resolution error for target ' + uriToString(this.target) + ' due to xDS client transient error ' + error.details);
          this.reportResolutionError(error.details);
        }
      },
      onResourceDoesNotExist: () => {
        trace('Resolution error for target ' + uriToString(this.target) + ' and route config ' + this.latestRouteConfigName + ': RDS resource does not exist');
        this.reportResolutionError(`Route config ${this.latestRouteConfigName} does not exist`);
      }
    }
  }

  private refCluster(clusterName: string) {
    const refCount = this.clusterRefcounts.get(clusterName);
    if (refCount) {
      refCount.refCount += 1;
    }
  }

  private unrefCluster(clusterName: string) {
    const refCount = this.clusterRefcounts.get(clusterName);
    if (refCount) {
      refCount.refCount -= 1;
      if (!refCount.inLastConfig && refCount.refCount === 0) {
        this.clusterRefcounts.delete(clusterName);
        this.handleRouteConfig(this.latestRouteConfig!);
      }
    }
  }

  private handleRouteConfig(routeConfig: RouteConfiguration__Output) {
    this.latestRouteConfig = routeConfig;
    if (GRPC_XDS_EXPERIMENTAL_ROUTING) {
      const virtualHost = findVirtualHostForDomain(routeConfig.virtual_hosts, this.target.path);
      if (virtualHost === null) {
        this.reportResolutionError('No matching route found');
        return;
      }
      const allConfigClusters = new Set<string>();
      const matchList: {matcher: Matcher, action: () => string}[] = [];
      for (const route of virtualHost.routes) {
        let routeAction: () => string;
        switch (route.route!.cluster_specifier) {
          case 'cluster_header':
            continue;
          case 'cluster':{
            const cluster = route.route!.cluster!;
            allConfigClusters.add(cluster);
            routeAction = () => cluster;
            break;
          }
          case 'weighted_clusters': {
            let lastNumerator = 0;
            // clusterChoices is essentially the weighted choices represented as a CDF
            const clusterChoices: {cluster: string, numerator: number}[] = [];
            for (const clusterWeight of route.route!.weighted_clusters!.clusters) {
              allConfigClusters.add(clusterWeight.name);
              lastNumerator = lastNumerator + (clusterWeight.weight?.value ?? 0);
              clusterChoices.push({cluster: clusterWeight.name, numerator: lastNumerator});
            }
            routeAction = () => {
              const randomNumber = Math.random() * (route.route!.weighted_clusters!.total_weight?.value ?? 100);
              for (const choice of clusterChoices) {
                if (randomNumber < choice.numerator) {
                  return choice.cluster;
                }
              }
              // This should be prevented by the validation rules
              return '';
            }
          }
        }
        const routeMatcher = getPredicateForMatcher(route.match!);
        matchList.push({matcher: routeMatcher, action: routeAction});
      }
      /* Mark clusters that are not in this route config, and remove ones with
       * no references */
      for (const [name, refCount] of Array.from(this.clusterRefcounts.entries())) {
        if (!allConfigClusters.has(name)) {
          refCount.inLastConfig = false;
          if (refCount.refCount === 0) {
            this.clusterRefcounts.delete(name);
          }
        }
      }
      // Add any new clusters from this route config
      for (const name of allConfigClusters) {
        if (this.clusterRefcounts.has(name)) {
          this.clusterRefcounts.get(name)!.inLastConfig = true;
        } else {
          this.clusterRefcounts.set(name, {inLastConfig: true, refCount: 0});
        }
      }
      const configSelector: ConfigSelector = (methodName, metadata) => {
        for (const {matcher, action} of matchList) {
          if (matcher(methodName, metadata)) {
            const clusterName = action();
            this.refCluster(clusterName);
            const onCommitted = () => {
              this.unrefCluster(clusterName);
            }
            return {
              methodConfig: {name: []},
              onCommitted: onCommitted,
              pickInformation: {cluster: clusterName},
              status: status.OK
            };
          }
        }
        return {
          methodConfig: {name: []},
          // cluster won't be used here, but it's set because of some TypeScript weirdness
          pickInformation: {cluster: ''},
          status: status.UNAVAILABLE
        };
      };
      const clusterConfigMap = new Map<string, {child_policy: LoadBalancingConfig[]}>();
      for (const clusterName of this.clusterRefcounts.keys()) {
        clusterConfigMap.set(clusterName, {child_policy: [new CdsLoadBalancingConfig(clusterName)]});
      }
      const lbPolicyConfig = new XdsClusterManagerLoadBalancingConfig(clusterConfigMap);
      const serviceConfig: ServiceConfig = {
        methodConfig: [],
        loadBalancingConfig: [lbPolicyConfig]
      }
      this.listener.onSuccessfulResolution([], serviceConfig, null, configSelector, {});
    } else {
      // !GRPC_XDS_EXPERIMENTAL_ROUTING
      for (const virtualHost of routeConfig.virtual_hosts) {
        if (virtualHost.domains.indexOf(this.target.path) >= 0) {
          const route = virtualHost.routes[virtualHost.routes.length - 1];
          if (route.match?.prefix === '' && route.route?.cluster) {
            trace('Reporting RDS update for host ' + uriToString(this.target) + ' with cluster ' + route.route.cluster);
            this.listener.onSuccessfulResolution([], {
              methodConfig: [],
              loadBalancingConfig: [
                new CdsLoadBalancingConfig(route.route.cluster)
              ],
            }, null, null, {});
            this.hasReportedSuccess = true;
            return;
          } else {
            trace('Discarded matching route with prefix ' + route.match?.prefix + ' and cluster ' + route.route?.cluster);
          }
        }
      }
      this.reportResolutionError('No matching route found');
    }
  }

  private reportResolutionError(reason: string) {
    this.listener.onError({
      code: status.UNAVAILABLE,
      details: `xDS name resolution failed for target ${uriToString(
        this.target
      )}: ${reason}`,
      metadata: new Metadata(),
    });
  }

  updateResolution(): void {
    // Wait until updateResolution is called once to start the xDS requests
    if (!this.isLdsWatcherActive) {
      trace('Starting resolution for target ' + uriToString(this.target));
      getSingletonXdsClient().addListenerWatcher(this.target.path, this.ldsWatcher);
      this.isLdsWatcherActive = true;
    }
  }

  destroy() {
    getSingletonXdsClient().removeListenerWatcher(this.target.path, this.ldsWatcher);
    if (this.latestRouteConfigName) {
      getSingletonXdsClient().removeRouteWatcher(this.latestRouteConfigName, this.rdsWatcher);
    }
  }

  static getDefaultAuthority(target: GrpcUri) {
    return target.path;
  }
}

export function setup() {
  registerResolver('xds', XdsResolver);
}
