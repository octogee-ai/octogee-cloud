#!/usr/bin/env python3
"""Generate the Octogee Grafana SPOG dashboard set.

Source of truth for every committed dashboard JSON under platform/, gateways/,
and tracing/. Edit the panel definitions here and re-run to regenerate; the
sidecar deploy (setup-monitoring.sh) wraps each JSON in a folder-annotated
ConfigMap. Folders are derived from the output subdirectory.

All dashboards template `$datasource` (Prometheus) + `$namespace` across the
central and west PROD/TEST namespaces so one shared Grafana serves both regions.
Gateway boards add a `$gateway` job selector.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DS = "${datasource}"
NS = '$namespace'
KSM_JOB = 'gmp-kube-state-metrics'


def pin_ksm(expr):
    def replace(match):
        metric = match.group(1)
        labels = match.group(3)
        if labels is None:
            return f'{metric}{{job="{KSM_JOB}"}}'
        if re.search(r'(^|,)\s*job\s*=~?', labels):
            return match.group(0)
        separator = ',' if labels else ''
        return f'{metric}{{job="{KSM_JOB}"{separator}{labels}}}'

    return re.sub(r'\b(kube_[a-z0-9_]+)(\{([^}]*)\})?', replace, expr)


def ds():
    return {"type": "prometheus", "uid": "${datasource}"}


def tmpl_datasource(default="Managed Prometheus"):
    # Single source of truth: Google Managed Service for Prometheus (queried via
    # the gmp-frontend). On Autopilot the self-managed Prometheus can't scrape
    # kubelets; GMP collects system (cAdvisor/kubelet) + kube-state + app metrics.
    return {
        "name": "datasource", "label": "Datasource", "type": "datasource",
        "query": "prometheus", "current": {"text": default, "value": default},
        "hide": 0, "refresh": 1,
    }


def tmpl_namespace():
    return {
        "name": "namespace", "label": "Namespace", "type": "query",
        "datasource": ds(),
        "query": {"query": f'label_values(kube_pod_info{{job="{KSM_JOB}"}}, namespace)', "refId": "ns"},
        "regex": "/^(__ENVIRONMENT_NAMESPACES__)$/",
        "current": {"text": "octogee", "value": "octogee"},
        "includeAll": False, "multi": False, "refresh": 2, "sort": 1,
    }


def tmpl_gateway():
    return {
        "name": "gateway", "label": "Gateway", "type": "query",
        "datasource": ds(),
        "query": {"query": 'label_values(up{namespace="$namespace",job=~"octogee-gateway.*"}, job)', "refId": "gw"},
        "current": {"text": "All", "value": "$__all"},
        "includeAll": True, "multi": True, "refresh": 2, "sort": 1,
    }


def tmpl_gwpod():
    # cAdvisor / kube-state metrics key on `pod`, not the `job` the openclaw
    # scrape uses — so the sizing board selects gateway *pods* by name.
    return {
        "name": "gwpod", "label": "Gateway pod", "type": "query",
        "datasource": ds(),
        "query": {"query": 'label_values(kube_pod_info{namespace="$namespace",pod=~"octogee-gateway-.*"}, pod)', "refId": "gwpod"},
        "current": {"text": "All", "value": "$__all"},
        "includeAll": True, "multi": True, "refresh": 2, "sort": 1,
    }


_id = [0]


def nid():
    _id[0] += 1
    return _id[0]


def target(expr, legend="", refId="A"):
    return {"datasource": ds(), "expr": pin_ksm(expr), "legendFormat": legend, "refId": refId}


# A group-by only takes effect under a cross-series reducer, and the legend is
# built from the same labels so a "by X" panel actually reads by X.
def cloud_target(metric_type, legend="", refId="A", group_bys=None,
                 metric_kind="DELTA", value_type="INT64", aligner="ALIGN_SUM",
                 filters=None):
    group_bys = group_bys or []
    alias = legend or " · ".join("{{" + g + "}}" for g in group_bys)
    return {
        "datasource": {"type": "stackdriver", "uid": "cloud-monitoring"},
        "metricQuery": {
            "projectName": "octogee",
            "metricType": metric_type,
            "metricKind": metric_kind,
            "valueType": value_type,
            "alignmentPeriod": "cloud-monitoring-auto",
            "perSeriesAligner": aligner,
            "crossSeriesReducer": "REDUCE_SUM" if group_bys else "REDUCE_NONE",
            "groupBys": group_bys,
            "filters": filters or [],
            "aliasBy": alias,
        },
        "refId": refId,
    }


# TEST and PROD share the CENTRAL cluster and both write to the same log metric;
# metrics that carry a namespace label follow the board's $namespace like every
# Prometheus panel does.
NAMESPACE_FILTER = ["metric.label.namespace", "=", "$namespace"]


def cloud_panel(title, metric_type, unit="short", w=12, h=8,
                group_bys=None, legend=True, desc="", kind="timeseries",
                thresholds=None, filters=None):
    steps = thresholds or [{"color": "green", "value": None}]
    if kind == "stat":
        return {
            "id": nid(), "type": "stat", "title": title,
            "datasource": {"type": "stackdriver", "uid": "cloud-monitoring"},
            "description": desc,
            "targets": [cloud_target(metric_type, "", "A", group_bys, filters=filters)],
            "fieldConfig": {"defaults": {"unit": unit, "color": {"mode": "thresholds"},
                            "thresholds": {"mode": "absolute", "steps": steps}}, "overrides": []},
            "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                        "textMode": "auto", "colorMode": "value", "graphMode": "area"},
            "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
        }
    return {
        "id": nid(), "type": "timeseries", "title": title,
        "datasource": {"type": "stackdriver", "uid": "cloud-monitoring"},
        "description": desc,
        "targets": [cloud_target(metric_type, "", "A", group_bys, filters=filters)],
        "fieldConfig": {"defaults": {"unit": unit, "custom": {
            "drawStyle": "line", "fillOpacity": 15, "showPoints": "never", "lineWidth": 1,
            "stacking": {"mode": "normal" if not legend else "none", "group": "A"}}}, "overrides": []},
        "options": {"legend": {"displayMode": "table" if legend else "list", "placement": "bottom",
                    "calcs": ["lastNotNull", "max"] if legend else []},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
        "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
    }


def _targets(exprs):
    out = []
    for i, e in enumerate(exprs):
        if isinstance(e, tuple):
            out.append(target(e[0], e[1], chr(65 + i)))
        else:
            out.append(target(e, "", chr(65 + i)))
    return out


def stat(title, exprs, unit="short", w=6, h=4, thresholds=None, color="thresholds", text_mode="auto", drilldown=None):
    steps = thresholds or [{"color": "green", "value": None}]
    defaults = {"unit": unit, "color": {"mode": color},
                "thresholds": {"mode": "absolute", "steps": steps}}
    if drilldown:
        defaults["links"] = drilldown
    return {
        "id": nid(), "type": "stat", "title": title, "datasource": ds(),
        "targets": _targets(exprs),
        "fieldConfig": {"defaults": defaults, "overrides": []},
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "textMode": text_mode, "colorMode": "value", "graphMode": "none", "justifyMode": "auto"},
        "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
    }


def ts(title, exprs, unit="short", w=12, h=8, legend=None, stack=False, desc=""):
    return {
        "id": nid(), "type": "timeseries", "title": title, "datasource": ds(),
        "description": desc,
        "targets": _targets(exprs),
        "fieldConfig": {"defaults": {"unit": unit, "custom": {
            "drawStyle": "line", "fillOpacity": 10 if not stack else 30,
            "showPoints": "never", "lineWidth": 1,
            "stacking": {"mode": "normal" if stack else "none", "group": "A"}}}, "overrides": []},
        "options": {"legend": {"displayMode": "table" if legend else "list",
                    "placement": "bottom", "calcs": ["lastNotNull", "max"] if legend else []},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
        "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
    }


def table(title, exprs, w=12, h=8, transformations=None):
    p = {
        "id": nid(), "type": "table", "title": title, "datasource": ds(),
        "targets": [dict(t, format="table", instant=True) for t in _targets(exprs)],
        "fieldConfig": {"defaults": {"custom": {"align": "auto"}}, "overrides": []},
        "options": {"showHeader": True}, "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
    }
    if transformations:
        p["transformations"] = transformations
    return p


def text(title, markdown, w=24, h=6):
    return {
        "id": nid(), "type": "text", "title": title,
        "options": {"mode": "markdown", "content": markdown},
        "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
    }


def row(title):
    return {"id": nid(), "type": "row", "title": title, "collapsed": False,
            "gridPos": {"h": 1, "w": 24, "x": 0, "y": 0}, "panels": []}


def layout(panels):
    """Flow panels left-to-right, wrapping at width 24; rows reset the cursor."""
    x = y = rowh = 0
    for p in panels:
        if p["type"] == "row":
            y += rowh
            p["gridPos"] = {"h": 1, "w": 24, "x": 0, "y": y}
            y += 1
            x = rowh = 0
            continue
        w, h = p["gridPos"]["w"], p["gridPos"]["h"]
        if x + w > 24:
            y += rowh
            x = rowh = 0
        p["gridPos"] = {"h": h, "w": w, "x": x, "y": y}
        x += w
        rowh = max(rowh, h)
    return panels


def dashboard(uid, title, panels, tmpls, links=None, refresh="30s", tags=None):
    return {
        "uid": uid, "title": title, "schemaVersion": 39, "version": 1,
        "editable": True, "refresh": refresh, "time": {"from": "now-6h", "to": "now"},
        "tags": tags or [], "links": links or [],
        "templating": {"list": tmpls},
        "panels": layout(panels),
    }


def dlink(title, dash_tag):
    return {"title": title, "type": "dashboards", "tags": [dash_tag], "asDropdown": True,
            "includeVars": True, "keepTime": True, "icon": "external link"}


def panel_link(title, path):
    separator = '&' if '?' in path else '?'
    return [{
        "title": title,
        "url": f'{path}{separator}var-namespace=${{namespace}}&var-datasource=${{datasource}}&from=${{__from}}&to=${{__to}}',
    }]


# ─────────────────────────── PLATFORM ───────────────────────────
PLAT_JOBS = 'octogee-api|gateway-edge'


def d_overview():
    p = [
        text("Start here", "**Green means no action. Click any number to open the one dashboard that explains it.** "
             "Use the Namespace picker to choose the environment.", h=3),
        row("Act now"),
        stat("Firing alerts", [f'count(ALERTS{{alertstate="firing",namespace="{NS}"}}) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}],
             drilldown=panel_link("Open Alerting", "/alerting/list")),
        stat("Unavailable deployments", [f'sum(kube_deployment_status_replicas_unavailable{{namespace="{NS}"}}) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}],
             drilldown=panel_link("Open workload health", "/d/octogee-container-health/workload-health")),
        stat("Scrape targets down", [f'count((up{{namespace="{NS}",job=~"octogee-api|octogee-gateway|gateway-edge|gitea|glm-controller"}} == 0) and on(namespace,pod) (kube_pod_status_ready{{namespace="{NS}",condition="true"}} == 1)) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 2}],
             drilldown=panel_link("Open service health", "/d/octogee-services/service-health")),
        stat("Active restarts (24h)", [f'sum(increase(kube_pod_container_status_restarts_total{{namespace="{NS}"}}[24h]) and on(namespace,pod) (kube_pod_status_ready{{namespace="{NS}",condition="true"}} == 1)) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 10}],
             drilldown=panel_link("Open restart offenders", "/d/octogee-container-health/workload-health")),
        row("Can users use the platform?"),
        stat("Core services down", [f'4 - (count(kube_deployment_status_replicas_available{{namespace="{NS}",deployment=~"octogee-api|octogee-gitea|mattermost|glm-controller"}} >= 1) or vector(0))'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}],
             drilldown=panel_link("Open workload health", "/d/octogee-container-health/workload-health")),
        stat("Ready gateways", [f'count(kube_deployment_status_replicas_available{{namespace="{NS}",deployment=~"octogee-gateway-.*"}} >= 1) or vector(0)'],
             thresholds=[{"color": "red", "value": None}, {"color": "yellow", "value": 2}, {"color": "green", "value": 3}],
             drilldown=panel_link("Open fleet health", "/d/octogee-fleet/fleet-health")),
        stat("Fleet controller reconcile age", [f'(time()-max(glm_reconcile_last_success_timestamp_seconds{{namespace="{NS}"}})) or vector(0)'],
             unit="s", thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 300}, {"color": "red", "value": 900}],
             drilldown=panel_link("Open fleet health", "/d/octogee-fleet/fleet-health")),
        stat("Activity projection connected", [f'min(octogee_activity_projection_boot_status{{namespace="{NS}",status="connected"}}) or vector(0)'],
             thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 1}],
             drilldown=panel_link("Open Activity publisher", "/d/octogee-bridge/activity-bridge")),
        row("Traffic and outcomes"),
        stat("API req/s", [f'sum(rate(http_requests_total{{namespace="{NS}",job="octogee-api"}}[5m])) or vector(0)'], unit="reqps",
             drilldown=panel_link("Open API health", "/d/octogee-services/service-health")),
        stat("API 5xx %", [f'(100*sum(rate(http_requests_total{{namespace="{NS}",job="octogee-api",status=~"5.."}}[5m]))/clamp_min(sum(rate(http_requests_total{{namespace="{NS}",job="octogee-api"}}[5m])),0.001)) or vector(0)'],
             unit="percent", thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 5}],
             drilldown=panel_link("Open API health", "/d/octogee-services/service-health")),
        stat("Agent turns/min", [f'sum(rate(octogee_agent_end_total{{namespace="{NS}"}}[5m]))*60 or vector(0)'],
             drilldown=panel_link("Open agent activity", "/d/octogee-gateway/agent-activity")),
        row("Trends"),
        ts("API + Edge request rate", [(f'sum(rate(http_requests_total{{namespace="{NS}",job=~"{PLAT_JOBS}"}}[5m])) by (job) or vector(0)', "{{job}}")], unit="reqps"),
        ts("Agent turns / min", [(f'sum(rate(octogee_agent_end_total{{namespace="{NS}"}}[5m]))*60 or vector(0)', "turns/min")]),
    ]
    return dashboard("octogee-overview", "Octogee — Overview", p,
                     [tmpl_datasource(), tmpl_namespace()],
                     links=[dlink("Platform", "platform"), dlink("Gateways", "gateway")],
                     tags=["octogee", "platform"])


def d_services():
    j = PLAT_JOBS
    p = [
        row("HTTP (octogee-api + gateway-edge)"),
        ts("Request rate by job", [(f'sum(rate(http_requests_total{{namespace="{NS}",job=~"{j}"}}[5m])) by (job)', "{{job}}")], unit="reqps", legend=True),
        ts("p99 latency by job", [(f'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{{namespace="{NS}",job=~"{j}"}}[5m])) by (le,job))', "{{job}}")], unit="s", legend=True),
        ts("Error rate (4xx/5xx) by job", [
            (f'sum(rate(http_requests_total{{namespace="{NS}",job=~"{j}",status=~"5.."}}[5m])) by (job) or vector(0)', "5xx {{job}}"),
            (f'sum(rate(http_requests_total{{namespace="{NS}",job=~"{j}",status=~"4.."}}[5m])) by (job) or vector(0)', "4xx {{job}}")],
           unit="reqps", legend=True),
        ts("Requests by route (top)", [(f'topk(10, sum(rate(http_requests_total{{namespace="{NS}",job=~"{j}"}}[5m])) by (route))', "{{route}}")], unit="reqps", legend=True),
        row("Node.js runtime"),
        ts("Heap used", [(f'nodejs_heap_size_used_bytes{{namespace="{NS}",job=~"{j}"}}', "{{job}} {{pod}}")], unit="bytes"),
        ts("Event-loop lag p99", [(f'nodejs_eventloop_lag_p99_seconds{{namespace="{NS}",job=~"{j}"}}', "{{job}} {{pod}}")], unit="s"),
        row("Fleet controller (glm-controller) — fleet reconcile"),
        ts("Reconcile rate by result", [(f'sum(rate(glm_reconcile_total{{namespace="{NS}"}}[5m])) by (result)', "{{result}}")], unit="ops", legend=True),
        stat("Reconcile last-success age", [f'time()-max(glm_reconcile_last_success_timestamp_seconds{{namespace="{NS}"}})'],
             unit="s", w=6, h=4, thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 300}, {"color": "red", "value": 900}]),
        stat("Reconcile failures (1h)", [f'sum(increase(glm_reconcile_total{{namespace="{NS}",result="fail"}}[1h])) or vector(0)'],
             w=6, h=4, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
    ]
    return dashboard("octogee-services", "Platform — API / Edge / Fleet controller", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


def d_container_health():
    deployment_columns = {
        "id": "organize",
        "options": {
            "excludeByName": {"Time": True, "job": True, "instance": True},
            "renameByName": {
                "namespace": "Environment",
                "deployment": "Deployment",
                "Value #A": "Planned",
                "Value #B": "Ready",
                "Value #C": "Unavailable",
            },
        },
    }
    container_columns = {
        "id": "organize",
        "options": {
            "excludeByName": {"Time": True, "job": True, "instance": True, "uid": True},
            "renameByName": {
                "namespace": "Environment",
                "pod": "Pod",
                "container": "Container",
                "node": "Node",
                "Value": "Ready",
            },
        },
    }
    p = [
        text("Use this when the home page is not green", "This board answers **which workload is unhealthy and which container restarted**. "
             "Start with the red stat, then the offender tables; use CPU and memory only after workload state is healthy.", h=3),
        row("Workload state"),
        stat("Unavailable deployments", [f'sum(kube_deployment_status_replicas_unavailable{{namespace="{NS}"}}) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("Crash-looping containers", [f'count(kube_pod_container_status_waiting_reason{{namespace="{NS}",reason="CrashLoopBackOff"}} == 1) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("Active restarted containers (24h)", [f'count((sum by (namespace,pod,container) (increase(kube_pod_container_status_restarts_total{{namespace="{NS}"}}[24h])) > 0) and on(namespace,pod) (kube_pod_status_ready{{namespace="{NS}",condition="true"}} == 1)) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 5}]),
        table("Deployments — planned vs ready", [
            (f'sum by (namespace,deployment) (kube_deployment_spec_replicas{{namespace="{NS}"}})', "planned"),
            (f'sum by (namespace,deployment) (kube_deployment_status_replicas_ready{{namespace="{NS}"}})', "ready"),
            (f'sum by (namespace,deployment) (kube_deployment_status_replicas_unavailable{{namespace="{NS}"}})', "unavailable"),
        ], w=24, h=8, transformations=[{"id": "merge", "options": {}}, deployment_columns]),
        table("Active restart offenders (24h)", [(f'topk(20, (sum by (namespace,pod,container) (increase(kube_pod_container_status_restarts_total{{namespace="{NS}"}}[24h])) > 0) and on(namespace,pod) (kube_pod_status_ready{{namespace="{NS}",condition="true"}} == 1))', "{{pod}}/{{container}}")]),
        table("Active service containers", [
            (f'sum by (namespace,pod,node,container) ((kube_pod_container_status_ready{{namespace="{NS}",container!=""}} == 1) * on(namespace,pod) group_left(node) kube_pod_info{{namespace="{NS}"}})', "{{pod}}/{{container}}"),
        ], w=24, h=10, transformations=[container_columns]),
        row("Resources"),
        ts("CPU usage by pod", [(f'sum(rate(container_cpu_usage_seconds_total{{namespace="{NS}",container!=""}}[5m])) by (pod)', "{{pod}}")], unit="short", legend=True),
        ts("Memory working set by pod", [(f'sum(container_memory_working_set_bytes{{namespace="{NS}",container!=""}}) by (pod)', "{{pod}}")], unit="bytes", legend=True),
    ]
    return dashboard("octogee-container-health", "Platform — Container Health", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


def d_gitea():
    p = [
        text("Gitea metrics", "Gitea exposes `gitea_*` gauges on its http port (`[metrics] ENABLED=true`). "
             "Scrape reachability requires the `allow-monitoring-scrape` NetworkPolicy. If panels are empty, "
             "check the gitea ServiceMonitor scrape timeout (gauges are DB-backed and can be slow).", h=4),
        row("Repository & user counts"),
        stat("Repositories", [f'gitea_repositories{{namespace="{NS}"}}']),
        stat("Users", [f'gitea_users{{namespace="{NS}"}}']),
        stat("Organizations", [f'gitea_organizations{{namespace="{NS}"}}']),
        stat("Issues", [f'gitea_issues{{namespace="{NS}"}}']),
        ts("Gitea entity counts", [
            (f'gitea_repositories{{namespace="{NS}"}}', 'repos'), (f'gitea_users{{namespace="{NS}"}}', 'users'),
            (f'gitea_issues{{namespace="{NS}"}}', 'issues'), (f'gitea_milestones{{namespace="{NS}"}}', 'milestones')], legend=True),
        row("Container health"),
        ts("Gitea pod memory", [(f'sum(container_memory_working_set_bytes{{namespace="{NS}",pod=~"octogee-gitea.*",container!=""}})', "mem")], unit="bytes"),
    ]
    return dashboard("octogee-gitea", "Platform — Gitea", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


def d_mattermost():
    p = [
        text("Mattermost observability", "Mattermost's native Prometheus metrics (`:8067/metrics`) are an "
             "**Enterprise-licensed** feature — the unlicensed server returns `404`, so `mattermost_*` series are "
             "unavailable. This board instead tracks gateway-edge Activity/control traffic plus container metrics. "
             "Native MM metrics light up automatically if a license is added.", h=5),
        row("Gateway-edge → Mattermost interaction"),
        ts("Activity intake outcomes", [(f'sum(rate(octogee_activity_intake_total{{namespace="{NS}"}}[5m])) by (outcome) or vector(0)', "{{outcome}}")], unit="ops", legend=True),
        ts("Reaction control drops", [(f'sum(rate(octogee_activity_reaction_dropped_total{{namespace="{NS}"}}[5m])) by (reason) or vector(0)', "{{reason}}")], unit="ops", legend=True),
        ts("OpenClaw WS connections", [(f'sum(chat_proxy_openclaw_ws_connections_active{{namespace="{NS}"}}) or vector(0)', "active")]),
        row("Container health"),
        ts("Mattermost pod memory", [(f'sum(container_memory_working_set_bytes{{namespace="{NS}",pod=~"mattermost.*",container!=""}})', "mem")], unit="bytes"),
        ts("Mattermost pod restarts", [(f'sum(increase(kube_pod_container_status_restarts_total{{namespace="{NS}",pod=~"mattermost.*"}}[1h]))', "restarts/h")]),
    ]
    return dashboard("octogee-mattermost", "Platform — Mattermost", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


def d_postgres():
    p = [
        text("CloudSQL / PostgreSQL", "The platform DB is **Cloud SQL** (`octogee-pg`), reached via `cloud-sql-proxy` "
             "— there is no in-cluster Postgres exporter, so engine metrics (CPU, connections, disk, replication) live "
             "in **Cloud Monitoring**. Add panels here against the *Cloud Monitoring* datasource "
             "(`cloudsql.googleapis.com/database/*`), or view them in the GCP console. Proxy/pod health below is from "
             "Prometheus.", h=5),
        row("cloud-sql-proxy health"),
        ts("Proxy pod memory", [(f'sum(container_memory_working_set_bytes{{namespace="{NS}",pod=~"cloud-sql-proxy.*",container!=""}})', "mem")], unit="bytes"),
        ts("Proxy pod restarts", [(f'sum(increase(kube_pod_container_status_restarts_total{{namespace="{NS}",pod=~"cloud-sql-proxy.*"}}[1h]))', "restarts/h")]),
    ]
    return dashboard("octogee-postgres", "Platform — PostgreSQL (Cloud SQL)", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "platform"])


# ─────────────────────────── GATEWAYS ───────────────────────────
def d_agent():
    g = '$gateway'
    p = [
        row("Agent activity"),
        stat("Users on fleet", [f'sum(octogee_customers_total{{namespace="{NS}",job=~"{g}"}}) or vector(0)']),
        stat("Throttle level (max)", [f'max(octogee_throttle_level{{namespace="{NS}",job=~"{g}"}}) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 2}]),
        stat("Agent turns/min", [f'sum(rate(octogee_agent_end_total{{namespace="{NS}",job=~"{g}"}}[5m]))*60 or vector(0)']),
        stat("Classifications/min", [f'sum(rate(octogee_classify_total{{namespace="{NS}",job=~"{g}"}}[5m]))*60 or vector(0)']),
        row("Throughput by gateway"),
        ts("Agent turns/min by gateway", [(f'sum(rate(octogee_agent_end_total{{namespace="{NS}",job=~"{g}"}}[5m])) by (job) * 60 or vector(0)', "{{job}}")], legend=True),
        ts("Classify rate by gateway", [(f'sum(rate(octogee_classify_total{{namespace="{NS}",job=~"{g}"}}[5m])) by (job) * 60 or vector(0)', "{{job}}")], legend=True),
        ts("Classify duration p95", [(f'histogram_quantile(0.95, sum(rate(octogee_classify_duration_seconds_bucket{{namespace="{NS}",job=~"{g}"}}[5m])) by (le,job)) or vector(0)', "{{job}}")], unit="s", legend=True),
        ts("Users per gateway", [(f'octogee_customers_total{{namespace="{NS}",job=~"{g}"}} or vector(0)', "{{job}}")], legend=True),
    ]
    return dashboard("octogee-gateway", "Gateways — Agent Observability", p,
                     [tmpl_datasource(), tmpl_namespace(), tmpl_gateway()], tags=["octogee", "gateway"])


def d_runner():
    g = '$gateway'
    p = [
        text("Runner health (:9092)", "The in-pod runner heartbeat (`octogee_runner_*`). `octogee_runner_up` is the "
             "liveness signal; a dropping `last_start` age or rising `restart_total` means the runner is flapping.", h=3),
        row("Runner liveness"),
        stat("Runners up", [f'sum(octogee_runner_up{{namespace="{NS}",job=~"{g}"}}) or vector(0)']),
        stat("Runners down", [f'count(octogee_runner_up{{namespace="{NS}",job=~"{g}"}}==0) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("Restarts (1h)", [f'sum(increase(octogee_runner_restart_total{{namespace="{NS}",job=~"{g}"}}[1h])) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 5}]),
        row("Per-gateway"),
        ts("Runner up by gateway", [(f'octogee_runner_up{{namespace="{NS}",job=~"{g}"}}', "{{job}}")], legend=True),
        ts("Restart rate by gateway", [(f'sum(rate(octogee_runner_restart_total{{namespace="{NS}",job=~"{g}"}}[15m])) by (job)', "{{job}}")], legend=True),
        ts("Time since last start", [(f'time()-octogee_runner_last_start_timestamp_seconds{{namespace="{NS}",job=~"{g}"}}', "{{job}}")], unit="s", legend=True),
    ]
    return dashboard("octogee-runner-health", "Gateways — Runner Health", p,
                     [tmpl_datasource(), tmpl_namespace(), tmpl_gateway()], tags=["octogee", "gateway"])


def d_fleet():
    deployment_columns = {
        "id": "organize",
        "options": {
            "excludeByName": {"Time": True, "job": True, "instance": True},
            "renameByName": {
                "namespace": "Environment",
                "deployment": "Gateway deployment",
                "Value #A": "Planned",
                "Value #B": "Ready",
                "Value #C": "Available",
            },
        },
    }
    pod_columns = {
        "id": "organize",
        "options": {
            "excludeByName": {"Time": True, "job": True, "instance": True, "uid": True},
            "renameByName": {
                "namespace": "Environment",
                "pod": "Active gateway pod",
                "node": "Node",
                "label_gateway_id": "Gateway",
                "label_gateway_class": "Class",
                "Value": "Ready",
            },
        },
    }
    container_columns = {
        "id": "organize",
        "options": {
            "excludeByName": {"Time": True, "job": True, "instance": True, "uid": True},
            "renameByName": {
                "namespace": "Environment",
                "pod": "Gateway pod",
                "container": "Container",
                "node": "Node",
                "Value": "Ready",
            },
        },
    }
    p = [
        text("Current fleet only", "This board uses the current Kubernetes desired and Ready state. "
             "Deleted rollout pods do not appear. A temporary surge is visible as **Ready > Planned**, rather than as a second gateway.", h=3),
        row("Fleet reconcile (fleet controller / glm-controller)"),
        stat("Reconcile last-success age", [f'time()-max(glm_reconcile_last_success_timestamp_seconds{{namespace="{NS}"}})'],
             unit="s", thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 300}, {"color": "red", "value": 900}]),
        stat("Reconciles (1h)", [f'sum(increase(glm_reconcile_total{{namespace="{NS}"}}[1h])) or vector(0)']),
        stat("Reconcile errors (1h)", [f'sum(increase(glm_reconcile_total{{namespace="{NS}",result="fail"}}[1h])) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("Ready gateways", [f'count(kube_deployment_status_replicas_available{{namespace="{NS}",deployment=~"octogee-gateway-.*"}} >= 1) or vector(0)']),
        row("Shared gateway capacity"),
        stat("Shared gateway assignments at last ceiling", [f'max(glm_shared_gateway_assignment_count{{namespace="{NS}"}}) or vector(0)']),
        stat("Shared gateway hot members at last ceiling", [f'max(glm_shared_gateway_hot_members{{namespace="{NS}"}}) or vector(0)']),
        stat("Shared gateway ceiling observations (1h)", [f'sum(increase(glm_shared_gateway_max_capacity_total{{namespace="{NS}"}}[1h])) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        row("Planned vs actual gateway deployments"),
        table("Gateway deployments — planned vs ready", [
            (f'sum by (namespace,deployment) (kube_deployment_spec_replicas{{namespace="{NS}",deployment=~"octogee-gateway-.*"}})', "planned"),
            (f'sum by (namespace,deployment) (kube_deployment_status_replicas_ready{{namespace="{NS}",deployment=~"octogee-gateway-.*"}})', "ready"),
            (f'sum by (namespace,deployment) (kube_deployment_status_replicas_available{{namespace="{NS}",deployment=~"octogee-gateway-.*"}})', "available"),
        ], w=24, h=8, transformations=[{"id": "merge", "options": {}}, deployment_columns]),
        row("Active gateway runtime"),
        table("Active gateway pods and nodes", [
            (f'sum by (namespace,pod,node,label_gateway_id,label_gateway_class) ((kube_pod_info{{namespace="{NS}",pod=~"octogee-gateway-.*"}} * on(namespace,pod) group_left(label_gateway_id,label_gateway_class) kube_pod_labels{{namespace="{NS}",pod=~"octogee-gateway-.*"}}) and on(namespace,pod) (kube_pod_status_ready{{namespace="{NS}",condition="true"}} == 1))', "{{pod}}"),
        ], w=24, h=10, transformations=[pod_columns]),
        table("Active gateway containers", [
            (f'sum by (namespace,pod,node,container) ((kube_pod_container_status_ready{{namespace="{NS}",pod=~"octogee-gateway-.*",container=~"gateway|gateway-edge"}} == 1) * on(namespace,pod) group_left(node) kube_pod_info{{namespace="{NS}",pod=~"octogee-gateway-.*"}})', "{{pod}}/{{container}}"),
        ], w=24, h=10, transformations=[container_columns]),
        row("Reconcile and scrape signals"),
        ts("Reconcile rate by result", [(f'sum(rate(glm_reconcile_total{{namespace="{NS}"}}[5m])) by (result)', "{{result}}")], unit="ops", legend=True),
        table("Current gateway scrape health", [(f'up{{namespace="{NS}",job=~"octogee-gateway.*"}} and on(namespace,pod) (kube_pod_status_ready{{namespace="{NS}",condition="true"}} == 1)', "{{pod}}")]),
        ts("Current gateway-edge scrape health", [(f'up{{namespace="{NS}",job=~"gateway-edge.*"}} and on(namespace,pod) (kube_pod_status_ready{{namespace="{NS}",condition="true"}} == 1)', "{{pod}}")], legend=True),
    ]
    return dashboard("octogee-fleet", "Gateways — Fleet / Fleet controller", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "gateway"])


def d_bridge():
    p = [
        row("Activity publisher (OpenClaw plugin → Mattermost)"),
        ts("Durable intake outcomes", [
            (f'sum(rate(octogee_activity_intake_total{{namespace="{NS}"}}[5m])) by (outcome) or vector(0)', "{{outcome}}")], unit="ops", legend=True),
        ts("Integrity and delivery violations", [
            (f'sum(rate(octogee_activity_orphan_total{{namespace="{NS}"}}[5m])) or vector(0)', "orphan"),
            (f'sum(rate(octogee_activity_routine_normal_delivery_total{{namespace="{NS}"}}[5m])) or vector(0)', "routine-not-silent")], unit="ops", legend=True),
        ts("Terminal and attachment failures", [
            (f'sum(rate(octogee_activity_missing_final_total{{namespace="{NS}"}}[5m])) or vector(0)', "missing-final"),
            (f'sum(rate(octogee_activity_attachment_unknown_total{{namespace="{NS}"}}[5m])) or vector(0)', "attachment-unknown")], unit="ops", legend=True),
        stat("Projection boot status", [f'max(octogee_activity_projection_boot_status{{namespace="{NS}"}}) or vector(0)']),
        row("OpenClaw WS proxy (folded chat-proxy)"),
        ts("Active WS connections", [(f'sum(chat_proxy_openclaw_ws_connections_active{{namespace="{NS}"}}) or vector(0)', "active")]),
        ts("WS handshakes / rotations recovered", [
            (f'sum(rate(chat_proxy_openclaw_ws_handshakes_total{{namespace="{NS}"}}[5m])) or vector(0)', "handshakes/s"),
            (f'sum(rate(chat_proxy_openclaw_ws_rotation_recovered_total{{namespace="{NS}"}}[5m])) or vector(0)', "rotations/s")], unit="ops", legend=True),
    ]
    return dashboard("octogee-bridge", "Gateways — Activity Publisher & WS", p,
                     [tmpl_datasource(), tmpl_namespace()], tags=["octogee", "gateway"])


def d_sizing():
    # cAdvisor + kube-state-metrics, keyed on the gateway *pod* and scoped to the
    # `gateway` container (the openclaw runtime the tier preset actually sizes;
    # the gateway-edge sidecar is fixed). Peaks use a subquery over $__range so
    # the numbers track whatever window the operator sets (push it to 7d–30d).
    pod = 'pod=~"$gwpod"'
    g = 'container="gateway"'
    cpu_peak = f'max_over_time(sum by(pod)(rate(container_cpu_usage_seconds_total{{namespace="{NS}",{pod},{g}}}[5m]))[$__range:5m])'
    cpu_lim = f'sum by(pod)(kube_pod_container_resource_limits{{namespace="{NS}",{pod},{g},resource="cpu"}})'
    mem_peak = f'max_over_time(sum by(pod)(container_memory_working_set_bytes{{namespace="{NS}",{pod},{g}}})[$__range:5m])'
    mem_lim = f'sum by(pod)(kube_pod_container_resource_limits{{namespace="{NS}",{pod},{g},resource="memory"}})'
    rename = {
        "id": "organize",
        "options": {
            "excludeByName": {"Time": True},
            "renameByName": {
                "pod": "Gateway pod",
                "Value #A": "Peak CPU (cores)", "Value #B": "CPU limit (cores)",
                "Value #C": "CPU % of limit", "Value #D": "Peak mem (GiB)",
                "Value #E": "Mem limit (GiB)", "Value #F": "Mem % of limit",
            },
        },
    }
    p = [
        text("Reading this board", (
            "**Right-size the `gateway` container's tier from real peak usage.** Gateways run **Guaranteed QoS** "
            "(requests == limits), so a pod can't burst past its tier — under-sizing surfaces as **OOMKills** "
            "(memory) or **CPU throttling**, never as >100% usage.\n\n"
            "- **Peak mem % of limit** is the binding signal — pick the **smallest tier that keeps peak under ~70%**.\n"
            "- **CPU throttled %** sustained above 0 means the agent wants more cores than the tier grants → size up.\n"
            "- **Window = the dashboard time range.** Set it to **7d–30d** (Prometheus retains 30d) for a real "
            "signal; the default `now-6h` is too short to size on.\n\n"
            "Tiers (cpu / mem): micro 0.5 / 2Gi · mini 1 / 4Gi · nano 2 / 8Gi · "
            "**small 4 / 16Gi (operator default)** · medium 8 / 32Gi · large 16 / 64Gi · "
            "xlarge 32 / 128Gi · 2xlarge 56 / 224Gi."
        ), h=6),
        row("Per-instance headroom — peak over the selected range"),
        table("Right-sizing summary (gateway container)", [
            (cpu_peak, "cpu_peak"),
            (cpu_lim, "cpu_lim"),
            (f'100 * {cpu_peak} / {cpu_lim}', "cpu_pct"),
            (f'{mem_peak} / 1073741824', "mem_peak_gib"),
            (f'{mem_lim} / 1073741824', "mem_lim_gib"),
            (f'100 * {mem_peak} / {mem_lim}', "mem_pct"),
        ], w=24, h=8, transformations=[{"id": "merge", "options": {}}, rename]),
        row("CPU"),
        ts("CPU cores — used vs limit", [
            (f'sum by(pod)(rate(container_cpu_usage_seconds_total{{namespace="{NS}",{pod},{g}}}[5m]))', "{{pod}} used"),
            (cpu_lim, "{{pod}} limit"),
        ], unit="short", legend=True),
        ts("CPU throttled %", [
            (f'100 * sum by(pod)(rate(container_cpu_cfs_throttled_periods_total{{namespace="{NS}",{pod},{g}}}[5m])) / clamp_min(sum by(pod)(rate(container_cpu_cfs_periods_total{{namespace="{NS}",{pod},{g}}}[5m])), 0.001)', "{{pod}}")],
           unit="percent", legend=True,
           desc="Sustained above 0 → the gateway is CPU-starved at this tier; size up."),
        row("Memory"),
        ts("Memory working set — used vs limit", [
            (f'sum by(pod)(container_memory_working_set_bytes{{namespace="{NS}",{pod},{g}}})', "{{pod}} used"),
            (mem_lim, "{{pod}} limit"),
        ], unit="bytes", legend=True),
        stat("Gateway pods OOM-killed (range)", [f'sum(max_over_time(kube_pod_container_status_last_terminated_reason{{namespace="{NS}",{pod},{g},reason="OOMKilled"}}[$__range])) or vector(0)'],
             w=6, h=4, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        row("Per-container breakdown (gateway vs gateway-edge sidecar)"),
        ts("CPU by container", [(f'sum by(pod,container)(rate(container_cpu_usage_seconds_total{{namespace="{NS}",{pod},container=~"gateway|gateway-edge"}}[5m]))', "{{pod}}/{{container}}")], unit="short", legend=True),
        ts("Memory by container", [(f'sum by(pod,container)(container_memory_working_set_bytes{{namespace="{NS}",{pod},container=~"gateway|gateway-edge"}})', "{{pod}}/{{container}}")], unit="bytes", legend=True),
    ]
    return dashboard("octogee-gateway-sizing", "Gateways — Right-Sizing", p,
                     [tmpl_datasource(), tmpl_namespace(), tmpl_gwpod()],
                     links=[dlink("Gateways", "gateway")], tags=["octogee", "gateway"])


# ─────────────────────────── TRACING ───────────────────────────
def d_tracing():
    md = (
        "## Tracing & APM (OpenTelemetry)\n\n"
        "**Status: not yet landing.** This is the third SPOG pillar (metrics ✓ · logs ✓ · traces ⏳), "
        "stubbed and ready to light up.\n\n"
        "### Current pipeline\n"
        "- No OTel collector or application instrumentation is deployed yet.\n\n"
        "### Intended (deferred prod-runtime work)\n"
        "1. Deploy an **OTel Collector** with the `googlecloud` exporter → **Cloud Trace**.\n"
        "2. Point `VITE_OTLP_ENDPOINT` at it → client traces land.\n"
        "3. Instrument octogee-api / gateway-edge / agent-run (OTLP → collector).\n\n"
        "### Where traces will be viewed\n"
        "Cloud Trace is explored in the **GCP Cloud Console** (no reliable Grafana trace datasource plugin). "
        "Once span-metrics exist, RED panels + exemplars can be added below.\n\n"
        "🔗 [Cloud Trace console](https://console.cloud.google.com/traces/list?project=octogee)"
    )
    p = [
        text("", md, h=18),
        row("Placeholders (light up when the collector lands)"),
        ts("Span ingest rate (collector)", [("vector(0)", "no data — collector not deployed")]),
        ts("Service RED — request rate from spans", [("vector(0)", "no data — instrument services")]),
    ]
    return dashboard("octogee-tracing", "Tracing & APM (OTel)", p,
                     [tmpl_datasource()], refresh="", tags=["octogee", "tracing"])


def d_spot_disruptions():
    logs_query = (
        "https://console.cloud.google.com/logs/query?project=octogee&query="
        "resource.type%3D%22gce_instance%22%0A"
        "log_id%28%22cloudaudit.googleapis.com%2Fsystem_event%22%29%0A"
        "protoPayload.methodName%3D%22compute.instances.preempted%22"
    )
    events_query = (
        "https://console.cloud.google.com/logs/query?project=octogee&query="
        "log_id%28%22events%22%29%0AjsonPayload.reason%3D%22NodeShutdown%22"
    )
    # Interleaves the audit preemption records with the fleet controller's pod-loss records so
    # the operator can match a preempted instance_id to the gateway that was on it.
    correlation_query = (
        "https://console.cloud.google.com/logs/query?project=octogee&query="
        "%28log_id%28%22cloudaudit.googleapis.com%2Fsystem_event%22%29%20AND%20"
        "protoPayload.methodName%3D%22compute.instances.preempted%22%29%20OR%20"
        "jsonPayload.schema%3D%22octogee.gateway-pod-replacement.v1%22"
    )
    p = [
        text("What this board proves", (
            "This is the substrate view for Spot and Kubernetes disruption. **A real Spot preemption is only "
            "confirmed by the Cloud Audit Log metric below** (`compute.instances.preempted`). Kubernetes events "
            "are correlated observations; `FailedScheduling: preemption` is scheduler fit logic, not Spot proof.\n\n"
            "The controller emits `octogee.disruption.v1` JSON records with node UID, provider/instance ID, "
            "capacity class, taints, gateway identity, assignment roster, and active fleet controller operations.\n\n"
            "The audit metric knows **which instance** was preempted but not which gateway was on it. The fleet controller "
            "records each gateway pod's instance id while the node still exists and emits "
            "`octogee.gateway-pod-replacement.v1` when that pod disappears with no desired-state change, so "
            "`instance_id` joins the two. Pod `RESTARTS` stays 0 through a preemption and Kubernetes events "
            "expire in ~1h — pod age is only a point-in-time hint.\n\n"
            f"[Authoritative Spot Audit Logs]({logs_query}) · [Kubernetes NodeShutdown events]({events_query}) · "
            f"[Preemption ↔ gateway correlation]({correlation_query})"
        ), h=7),
        row("Current placement").copy(),
        stat("Spot nodes", [f'sum(glm_disruption_nodes{{namespace="{NS}",capacity_class="spot"}}) or count(kube_node_labels{{label_cloud_google_com_gke_spot="true"}}) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}]),
        stat("On-demand nodes", [f'sum(glm_disruption_nodes{{namespace="{NS}",capacity_class="on-demand"}}) or count(kube_node_labels{{label_cloud_google_com_gke_provisioning="standard"}}) or vector(0)']),
        stat("Unknown capacity nodes", [f'sum(glm_disruption_nodes{{namespace="{NS}",capacity_class="unknown"}}) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}]),
        stat("Ready gateway pods", [f'count(kube_pod_info{{namespace="{NS}",pod=~"octogee-gateway-.*"}} and on(namespace,pod) (kube_pod_status_ready{{namespace="{NS}",condition="true"}} == 1)) or vector(0)']),
        stat("Gateway pods Pending", [f'count(kube_pod_status_phase{{namespace="{NS}",pod=~"octogee-gateway-.*",phase="Pending"}}==1) or vector(0)'],
             thresholds=[{"color": "green", "value": None}, {"color": "yellow", "value": 1}, {"color": "red", "value": 2}]),
        table("Spot node inventory", [
            ('kube_node_info * on(node) group_left(label_cloud_google_com_gke_spot,label_cloud_google_com_gke_provisioning,label_cloud_google_com_compute_class,label_topology_kubernetes_io_zone) kube_node_labels', "{{node}}"),
        ], w=24, h=8),
        table("Gateway pod → node → Octogee identity", [
            (f'(kube_pod_info{{namespace="{NS}",pod=~"octogee-gateway-.*"}} * on(namespace,pod) group_left(label_gateway_id,label_gateway_instance,label_gateway_class) kube_pod_labels{{namespace="{NS}",pod=~"octogee-gateway-.*"}} * on(node) group_left(label_cloud_google_com_gke_spot,label_cloud_google_com_gke_provisioning,label_cloud_google_com_compute_class,label_topology_kubernetes_io_zone) kube_node_labels) and on(namespace,pod) (kube_pod_status_ready{{namespace="{NS}",condition="true"}} == 1)', "{{pod}} → {{node}} · {{label_gateway_id}} · {{label_topology_kubernetes_io_zone}}"),
        ], w=24, h=9),
        row("Authoritative GCP evidence"),
        cloud_panel("Confirmed Spot preemptions by zone", "logging.googleapis.com/user/octogee_spot_preemptions",
                     unit="short", w=12, h=8, group_bys=["metric.label.zone"], legend=True,
                     desc="Derived from Compute Engine system audit logs with methodName=compute.instances.preempted."),
        cloud_panel("Structured disruption records by cause", "logging.googleapis.com/user/octogee_disruption_records",
                     unit="short", w=12, h=8, group_bys=["metric.label.cause", "metric.label.capacity_class"], legend=True,
                     filters=NAMESPACE_FILTER,
                     desc="Controller observations from Kubernetes Events; these are not independently authoritative Spot confirmations."),
        cloud_panel("Unplanned gateway pod losses by gateway", "logging.googleapis.com/user/octogee_gateway_pod_replacements",
                     unit="short", w=12, h=8, group_bys=["metric.label.gateway_id", "metric.label.node_pool"], legend=True,
                     filters=NAMESPACE_FILTER,
                     desc="Gateway pods that vanished while their ReplicaSet still wanted them running (a roll, restart, pause, or uninstall scales the ReplicaSet first and is excluded). Names the gateway a preemption hit; match metric.label.instance_id against the audit metric to confirm Spot as the cause."),
        cloud_panel("Unplanned gateway pod losses by vacated instance", "logging.googleapis.com/user/octogee_gateway_pod_replacements",
                     unit="short", w=12, h=8, group_bys=["metric.label.instance_id"], legend=True,
                     filters=NAMESPACE_FILTER,
                     desc="Join key against octogee_spot_preemptions: an instance id appearing in both is a confirmed Spot preemption of that gateway. instance_id=unknown means the pod was never observed on a node, so the loss is real but cannot be attributed."),
        row("Kubernetes signals"),
        ts("Controller observations by cause", [(f'sum(rate(glm_disruption_observations_total{{namespace="{NS}"}}[15m])) by (cause)', "{{cause}}")], unit="ops", legend=True),
        ts("Node conditions", [("sum(kube_node_status_condition{condition=\"Ready\",status=\"false\"})", "NotReady"), ("sum(kube_node_status_condition{condition=\"Ready\",status=\"true\"})", "Ready")], legend=True),
        table("Node taints observed by kube-state-metrics", [("kube_node_spec_taint", "{{node}} {{key}}={{value}}:{{effect}}")], w=24, h=7),
        row("Replacement pressure and fleet controller context"),
        ts("Pending gateway pods", [(f'sum(kube_pod_status_phase{{namespace="{NS}",pod=~"octogee-gateway-.*",phase="Pending"}}==1)', "Pending")], legend=True),
        ts("Fleet controller reconcile failures", [(f'sum(rate(glm_reconcile_total{{namespace="{NS}",result="fail"}}[15m]))', "fail/s")], legend=True),
        text("Action guide", (
            "- `compute.instances.preempted` + a node/pod event: **confirmed Spot preemption**.\n"
            "- Same `instance_id` in `octogee_gateway_pod_replacements` and `octogee_spot_preemptions`: "
            "**confirmed Spot preemption of that named gateway**.\n"
            "- An unplanned pod loss with no matching audit record is a node repair, an eviction, or an "
            "OOM-kill — the counter proves the loss, not the cause. `instance_id=unknown` means the pod was "
            "never observed on a node before it vanished, so no join is possible either way.\n"
            "- `NodeShutdown` without the audit event yet: **unconfirmed shutdown**, wait for the audit record.\n"
            "- `Killing` / `FailedPreStopHook`: termination behavior, not root cause.\n"
            "- `FailedScheduling` with `preemption: No preemption victims found`: scheduler capacity/fit, not Spot.\n"
            "- Shared gateway members are intentionally on-demand; Spot evidence should name only disposable isolated gateways."
        ), h=7),
    ]
    return dashboard("octogee-spot-disruptions", "GKE — Spot & Node Disruptions", p,
                     [tmpl_datasource(), tmpl_namespace()],
                     links=[dlink("Gateways / Fleet", "gateway"), dlink("Platform", "platform")],
                     refresh="30s", tags=["octogee", "kubernetes", "spot", "disruption"])


GROUPS = {
    "platform": [d_overview, d_services, d_container_health, d_gitea, d_mattermost, d_postgres, d_spot_disruptions],
    "gateways": [d_agent, d_runner, d_fleet, d_bridge, d_sizing],
    "tracing": [d_tracing],
}


def write_groups(root, groups):
    for folder, builders in groups.items():
        out = os.path.join(root, folder)
        os.makedirs(out, exist_ok=True)
        for b in builders:
            _id[0] = 0
            d = b()
            path = os.path.join(out, d["uid"] + ".json")
            with open(path, "w") as f:
                json.dump(d, f, indent=2)
                f.write("\n")
            print(f"wrote {folder}/{d['uid']}.json ({len(d['panels'])} panels)")


if __name__ == "__main__":
    write_groups(HERE, GROUPS)
