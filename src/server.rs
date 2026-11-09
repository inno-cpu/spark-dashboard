use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRef, State};
use axum::response::IntoResponse;
use axum::{routing::get, Router};
use rust_embed::Embed;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

use crate::config_store::{ConfigStore, MAX_DOCUMENT_BYTES};

#[derive(Embed)]
#[folder = "frontend/dist"]
struct FrontendAssets;

/// Reports that the dashboard configuration cannot be saved, so the client can
/// show its read-only banner *before* the operator arranges panels and tries.
/// Sent on every configuration response; the document itself has to come back
/// byte-identical, so the status cannot ride along in the body.
const READ_ONLY_HEADER: &str = "x-spark-dashboard-read-only";

/// Everything the router's handlers need. The metrics sender was previously the
/// whole state; it is reachable through [`FromRef`] so existing handlers keep
/// extracting `State<broadcast::Sender<String>>` unchanged.
#[derive(Clone)]
pub struct AppState {
    pub metrics_tx: broadcast::Sender<String>,
    pub config: Arc<ConfigStore>,
}

impl FromRef<AppState> for broadcast::Sender<String> {
    fn from_ref(state: &AppState) -> Self {
        state.metrics_tx.clone()
    }
}

pub fn create_router(state: AppState) -> Router {
    let api = Router::new()
        .route(
            "/dashboard",
            get(get_dashboard)
                .put(put_dashboard)
                .delete(delete_dashboard),
        )
        // One cap, enforced twice at the same threshold: the layer stops the
        // server buffering anything larger, and the handler rejects a body that
        // is exactly one byte over so the limit is ours rather than a tower
        // default that could drift.
        // The plugin host (:3199) is reached through this process so the
        // browser only ever talks to Spark's own origin. A host that is down
        // answers 503 here and changes nothing else on the dashboard.
        .route("/plugins", axum::routing::any(plugins_proxy))
        .route("/plugins/{*path}", axum::routing::any(plugins_proxy))
        .layer(DefaultBodyLimit::max(MAX_DOCUMENT_BYTES + 1))
        // Without this, the SPA fallback below would answer a typo'd or
        // unregistered API path with the app shell and status 200 — a client bug
        // would look like success.
        .fallback(api_not_found);

    // `mut` is only exercised by the Linux-gated log-viewer block below.
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut router = Router::new()
        .route("/ws", get(crate::ws::ws_handler))
        // Liveness probe for container HEALTHCHECK / orchestrators. Intentionally
        // dependency-free: it reports that the HTTP server is up, not that any
        // engine/GPU is healthy (that's surfaced over /ws).
        .route("/healthz", get(healthz))
        .route("/api/host/fans", get(host_fans))
        .route("/api/host/protection", get(host_protection))
        .route("/api/router/status", get(host_router))
        .route("/api/router/history", get(host_router_history))
        .route("/api/router/backend", get(host_router_backend))
        .route("/api/router/drain", axum::routing::post(host_router_drain))
        .route("/api/router/defaults", get(host_router_defaults))
        .route("/api/router/defaults", axum::routing::put(host_router_defaults_save))
        .route("/api/router/requests", get(host_router_requests))
        .route("/api/netdata/alarms", get(host_netdata_alarms))
        .route("/api/host/ownership", get(host_ownership))
        .route("/api/audit", get(host_audit))
        .route("/api/journal", get(host_journal))
        .route("/api/models/profiles", get(host_model_profiles))
        .route("/api/models", get(host_models))
        .route("/api/models/load", axum::routing::post(host_model_load))
        .route("/api/models/unload", axum::routing::post(host_model_unload))
        .route("/api/services", get(host_services))
        .route("/api/access", get(host_access))
        .route("/api/engine-key", get(host_engine_key))
        .route("/api/gateway-requests", get(host_gateway_requests))
        .route("/api/endpoints", get(host_endpoints))
        .route("/api/client/{name}", get(host_client_download))
        .route("/api/host/cooling", get(host_cooling))
        .route("/api/host/thermal-history", get(host_thermal_history))
        .route("/api/host/hbm", get(host_hbm))
        .route("/api/host/fan-curve", get(host_fan_curve))
        .route("/api/host/cooling-summary", get(host_cooling_summary))
        .nest("/api", api)
        .fallback(static_handler)
        .with_state(state)
        .layer(CorsLayer::permissive());

    // Conditionally register the experimental log viewer endpoint.
    // Gated behind --enable-log-viewer so deployments can opt out of
    // exposing unauthenticated container logs.
    #[cfg(target_os = "linux")]
    if crate::logs::is_log_viewer_enabled() {
        router = router.route("/ws/logs", get(crate::logs::ws_logs_handler));
    }

    router
}

async fn healthz() -> &'static str {
    "ok"
}

/// Forwards `/api/plugins…` to the plugin host, which owns the registry, the
/// template discovery and the per-plugin backend proxy. Deliberately a dumb
/// pass-through: this process knows no plugin, no template and no backend URL.
async fn plugins_proxy(
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let base = std::env::var("SPARK_PLUGIN_HOST_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3199".to_string());
    let path = uri.path().trim_start_matches("/api");
    let url = format!("{base}/api{path}");
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            return (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(serde_json::json!({"error": "plugin host unavailable", "detail": err.to_string()})),
            )
                .into_response()
        }
    };
    let mut request = client.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
        &url,
    );
    if let Some(value) = headers.get("content-type") {
        request = request.header("content-type", value.clone());
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            let bytes = response.bytes().await.unwrap_or_default();
            (status, [(axum::http::header::CONTENT_TYPE, content_type)], bytes).into_response()
        }
        Err(err) => (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({
                "error": "plugin host unavailable",
                "detail": err.to_string()
            })),
        )
            .into_response(),
    }
}

/// Returns the stored document verbatim, or `204 No Content` when nothing has
/// been stored. Absence is not an error — it is what a fresh install and a reset
/// both look like, and the client renders the default preset for it.
async fn get_dashboard(State(state): State<AppState>) -> impl IntoResponse {
    match state.config.load().await {
        Ok(Some(document)) => (
            axum::http::StatusCode::OK,
            [
                (
                    axum::http::header::CONTENT_TYPE,
                    // The server does not parse the document; this describes the
                    // media type the resource is defined to carry, not a claim
                    // that these particular bytes were validated.
                    "application/json".to_string(),
                ),
                (
                    axum::http::HeaderName::from_static(READ_ONLY_HEADER),
                    state.config.is_read_only().to_string(),
                ),
            ],
            document,
        )
            .into_response(),
        Ok(None) => no_content(&state),
        Err(err) => {
            tracing::error!("reading the dashboard configuration failed: {err}");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                read_only_headers(&state),
                "Failed to read the dashboard configuration",
            )
                .into_response()
        }
    }
}

/// Replaces the document wholesale. The body is stored exactly as received —
/// no parsing, no validation, no schema knowledge on this side of the wire.
async fn put_dashboard(State(state): State<AppState>, body: Bytes) -> impl IntoResponse {
    if body.len() > MAX_DOCUMENT_BYTES {
        return (
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            read_only_headers(&state),
            "Dashboard configuration exceeds the size limit",
        )
            .into_response();
    }

    if state.config.is_read_only() {
        return read_only_response(&state);
    }

    match state.config.store(&body).await {
        Ok(()) => no_content(&state),
        Err(err) => {
            tracing::error!("writing the dashboard configuration failed: {err}");
            write_failed_response(&state)
        }
    }
}

/// Removes the document, which is how a reset works: "the default preset" *is*
/// "the file does not exist".
async fn delete_dashboard(State(state): State<AppState>) -> impl IntoResponse {
    if state.config.is_read_only() {
        return read_only_response(&state);
    }

    match state.config.delete().await {
        Ok(()) => no_content(&state),
        Err(err) => {
            tracing::error!("deleting the dashboard configuration failed: {err}");
            write_failed_response(&state)
        }
    }
}

async fn api_not_found() -> impl IntoResponse {
    not_found()
}

fn not_found() -> axum::response::Response {
    (axum::http::StatusCode::NOT_FOUND, "Not Found").into_response()
}

fn no_content(state: &AppState) -> axum::response::Response {
    (axum::http::StatusCode::NO_CONTENT, read_only_headers(state)).into_response()
}

/// This instance cannot save at all, and no retry will change that.
fn read_only_response(state: &AppState) -> axum::response::Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        read_only_headers(state),
        "Dashboard configuration storage is read-only",
    )
        .into_response()
}

/// The state directory was writable at startup but this write still failed — a
/// full or failing disk, say. Deliberately *not* the read-only response: that
/// one promises a permanent condition the client should surface as a banner,
/// and the read-only header would contradict it.
fn write_failed_response(state: &AppState) -> axum::response::Response {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        read_only_headers(state),
        "Failed to save the dashboard configuration",
    )
        .into_response()
}

fn read_only_headers(state: &AppState) -> [(axum::http::HeaderName, String); 1] {
    [(
        axum::http::HeaderName::from_static(READ_ONLY_HEADER),
        state.config.is_read_only().to_string(),
    )]
}

async fn static_handler(uri: axum::http::Uri) -> impl IntoResponse {
    let mut path = uri.path().trim_start_matches('/');

    // The nested API router's own fallback catches most unmatched API paths, but
    // not the bare prefix (`/api`, `/api/`), which never routes into the nest.
    // Those must not answer with the app shell either.
    if path == "api" || path.starts_with("api/") {
        return not_found();
    }

    if path.is_empty() {
        path = "index.html";
    }

    // Try exact file match first. Vite writes content-hashed names under
    // `assets/`, so those can be cached indefinitely; everything else must be
    // revalidated or a browser keeps an old bundle after a rebuild.
    if let Some(file) = FrontendAssets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        // Single-admin host: correctness over bandwidth. A stale bundle cost more
        // than re-reading 800 kB over loopback, so nothing is cached at all.
        let cache = "no-store";
        return (
            axum::http::StatusCode::OK,
            [
                (axum::http::header::CONTENT_TYPE, mime.as_ref().to_string()),
                (axum::http::header::CACHE_CONTROL, cache.to_string()),
            ],
            file.data.into_owned(),
        )
            .into_response();
    }

    // SPA fallback: serve index.html for any unmatched route. Never cached: it is
    // the file that names the current bundle.
    if let Some(index) = FrontendAssets::get("index.html") {
        return (
            axum::http::StatusCode::OK,
            [
                (axum::http::header::CONTENT_TYPE, "text/html".to_string()),
                (axum::http::header::CACHE_CONTROL, "no-store".to_string()),
            ],
            index.data.into_owned(),
        )
            .into_response();
    }

    (axum::http::StatusCode::NOT_FOUND, "Not Found").into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spawns the server over a fresh state directory and returns its address
    /// alongside the directory guard, which must stay alive for the test.
    async fn spawn(state_dir: &std::path::Path) -> String {
        let (tx, _rx) = broadcast::channel::<String>(16);
        let state = AppState {
            metrics_tx: tx,
            config: Arc::new(ConfigStore::new(state_dir).await),
        };
        let app = create_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        format!("http://{addr}")
    }

    #[tokio::test]
    async fn healthz_returns_ok() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        let resp = reqwest::get(format!("{base}/healthz"))
            .await
            .expect("request to /healthz");
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        assert_eq!(resp.text().await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn reading_with_no_document_reports_absent() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();

        assert_eq!(resp.status(), reqwest::StatusCode::NO_CONTENT);
        assert_eq!(resp.text().await.unwrap(), "");
    }

    #[tokio::test]
    async fn write_then_read_returns_the_document_byte_identically() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        let document = r#"{"schemaVersion":1,"pages":[{"name":"Overview"}]}"#;

        let put = reqwest::Client::new()
            .put(format!("{base}/api/dashboard"))
            .body(document)
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), reqwest::StatusCode::NO_CONTENT);

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        assert_eq!(resp.text().await.unwrap(), document);
    }

    #[tokio::test]
    async fn a_document_the_server_cannot_interpret_round_trips_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        // Deliberately not JSON: the server must store bytes, not documents.
        let opaque: Vec<u8> = vec![0xff, 0xfe, 0x00, b'{', b'n', b'o', b'p', b'e'];

        let put = reqwest::Client::new()
            .put(format!("{base}/api/dashboard"))
            .body(opaque.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), reqwest::StatusCode::NO_CONTENT);

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        assert_eq!(resp.bytes().await.unwrap().to_vec(), opaque);
    }

    #[tokio::test]
    async fn a_write_over_the_size_cap_is_rejected_and_leaves_the_document_alone() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        let client = reqwest::Client::new();

        client
            .put(format!("{base}/api/dashboard"))
            .body("original")
            .send()
            .await
            .unwrap();

        let oversized = vec![b'x'; MAX_DOCUMENT_BYTES + 1];
        let put = client
            .put(format!("{base}/api/dashboard"))
            .body(oversized)
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(resp.text().await.unwrap(), "original");
    }

    #[tokio::test]
    async fn delete_removes_the_document_and_a_later_read_reports_absent() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;
        let client = reqwest::Client::new();

        client
            .put(format!("{base}/api/dashboard"))
            .body("{}")
            .send()
            .await
            .unwrap();

        let deleted = client
            .delete(format!("{base}/api/dashboard"))
            .send()
            .await
            .unwrap();
        assert_eq!(deleted.status(), reqwest::StatusCode::NO_CONTENT);

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn a_writable_instance_reports_that_it_is_not_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();

        assert_eq!(
            resp.headers().get(READ_ONLY_HEADER).unwrap(),
            "false",
            "read-only status must be discoverable from the read"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_unwritable_state_directory_serves_reads_and_refuses_writes() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        tokio::fs::create_dir(&state_dir).await.unwrap();
        tokio::fs::write(state_dir.join("dashboards.json"), b"{\"seeded\":true}")
            .await
            .unwrap();
        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o555))
            .await
            .unwrap();

        // Root ignores directory permissions; CI runs unprivileged, where this
        // exercises the real read-only path.
        let probe = state_dir.join(".privilege-check");
        if tokio::fs::write(&probe, b"").await.is_ok() {
            let _ = tokio::fs::remove_file(&probe).await;
            tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
                .await
                .unwrap();
            eprintln!("skipping: running privileged, directory permissions do not apply");
            return;
        }

        let base = spawn(&state_dir).await;

        // The server came up rather than refusing to start.
        let health = reqwest::get(format!("{base}/healthz")).await.unwrap();
        assert_eq!(health.status(), reqwest::StatusCode::OK);

        let read = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(read.status(), reqwest::StatusCode::OK);
        assert_eq!(read.headers().get(READ_ONLY_HEADER).unwrap(), "true");
        assert_eq!(read.text().await.unwrap(), "{\"seeded\":true}");

        let client = reqwest::Client::new();
        let write = client
            .put(format!("{base}/api/dashboard"))
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(write.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            write.headers().get(READ_ONLY_HEADER).unwrap(),
            "true",
            "the refusal must agree with the read-only header it carries"
        );

        let deleted = client
            .delete(format!("{base}/api/dashboard"))
            .send()
            .await
            .unwrap();
        assert_eq!(deleted.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(deleted.headers().get(READ_ONLY_HEADER).unwrap(), "true");

        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();
    }

    /// A directory that was writable at startup but is not any more. This is a
    /// plain failure, not the permanent read-only condition — reporting it as
    /// read-only would contradict the header, which still says `false`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_write_that_fails_after_startup_is_not_reported_as_read_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        tokio::fs::create_dir(&state_dir).await.unwrap();

        let base = spawn(&state_dir).await;
        let client = reqwest::Client::new();

        // Writable at startup, so the store probed clean.
        let first = client
            .put(format!("{base}/api/dashboard"))
            .body("original")
            .send()
            .await
            .unwrap();
        assert_eq!(first.status(), reqwest::StatusCode::NO_CONTENT);

        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o555))
            .await
            .unwrap();

        let probe = state_dir.join(".privilege-check");
        if tokio::fs::write(&probe, b"").await.is_ok() {
            let _ = tokio::fs::remove_file(&probe).await;
            tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
                .await
                .unwrap();
            eprintln!("skipping: running privileged, directory permissions do not apply");
            return;
        }

        let failed = client
            .put(format!("{base}/api/dashboard"))
            .body("replacement")
            .send()
            .await
            .unwrap();
        assert_eq!(failed.status(), reqwest::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            failed.headers().get(READ_ONLY_HEADER).unwrap(),
            "false",
            "the instance is not read-only; this write just failed"
        );

        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();

        // The failed write left the previous document untouched.
        let resp = reqwest::get(format!("{base}/api/dashboard")).await.unwrap();
        assert_eq!(resp.text().await.unwrap(), "original");
    }

    #[tokio::test]
    async fn an_unmatched_api_path_returns_404_rather_than_the_app_shell() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        for path in ["/api/nope", "/api/dashboard/extra", "/api/", "/api"] {
            let resp = reqwest::get(format!("{base}{path}")).await.unwrap();
            assert_eq!(
                resp.status(),
                reqwest::StatusCode::NOT_FOUND,
                "{path} should 404"
            );
        }
    }

    #[tokio::test]
    async fn an_unsupported_method_on_the_config_route_is_not_the_app_shell() {
        let dir = tempfile::tempdir().unwrap();
        let base = spawn(dir.path()).await;

        let resp = reqwest::Client::new()
            .post(format!("{base}/api/dashboard"))
            .body("{}")
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), reqwest::StatusCode::METHOD_NOT_ALLOWED);
    }
}


// ── host status (read-only) ─────────────────────────────────────────────────
// Cooling and protection read from the host's own exporters rather than from a
// plugin backend: the fan tachometers are IPMI values Prometheus already has,
// and the thermal guard's state lives in /run and in systemd. Nothing here
// writes, starts or stops anything.

const PROMETHEUS: &str = "http://127.0.0.1:9090";
const LATCH_PATH: &str = "/run/hyperqwen-thermal-block";
const HEARTBEAT_PATH: &str = "/run/cmp-gpu-guard-heartbeat";
const GUARD_CONF: &str = "/etc/cmp-gpu-guard.conf";
const PROTECTION_UNITS: [&str; 5] = [
    "smfc",
    "cmp-gpu-guard",
    "smfc-c80-monitor",
    "cmp-gpu-power-policy",
    "cmp-gpu-liveness-check.timer",
];

/// One PromQL instant query, returning `(labels, value)` pairs.
async fn promql(query: &str) -> Vec<(serde_json::Map<String, serde_json::Value>, f64)> {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(4)).build() {
        Ok(client) => client,
        Err(_) => return Vec::new(),
    };
    // Plain text rather than a JSON helper: the workspace builds reqwest
    // without its json feature, and these queries are identifiers.
    // its json feature, and these queries are identifiers, so no encoding is needed.
    let response = match client.get(format!("{PROMETHEUS}/api/v1/query?query={query}")).send().await {
        Ok(response) => response,
        Err(_) => return Vec::new(),
    };
    let text = match response.text().await {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    let body: serde_json::Value = match serde_json::from_str(&text) {
        Ok(body) => body,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    if let Some(results) = body.pointer("/data/result").and_then(|value| value.as_array()) {
        for result in results {
            let labels = result.get("metric").and_then(|value| value.as_object()).cloned().unwrap_or_default();
            let value = result
                .pointer("/value/1")
                .and_then(|value| value.as_str())
                .and_then(|value| value.parse::<f64>().ok());
            if let Some(value) = value {
                out.push((labels, value));
            }
        }
    }
    out
}

/// Fan RPMs (IPMI, via the Netdata job) and smfc's computed zone levels.
async fn host_fans() -> axum::response::Response {
    let fans = promql("netdata_cmpipmi_fans_RPM_average").await;
    let zones = promql("smfc_zone_level_percent").await;
    // Each fan's own measured maximum over the retained window. A 24 h window only
    // knows the idle band (1100-3600 here); FANC/FAND have reached 9800/10300 rpm,
    // so a bar scaled to 5100 would read "full" while idling.
    let ceilings: std::collections::HashMap<String, f64> =
        promql("vector(0)")
            .await
            .into_iter()
            .filter_map(|(labels, value)| {
                let name = labels.get("dimension").and_then(|v| v.as_str())?.to_string();
                if !name.to_uppercase().starts_with("FAN") {
                    return None;
                }
                Some((name, value))
            })
            .collect();
    let mut rows: Vec<serde_json::Value> = fans
        .into_iter()
        .filter_map(|(labels, rpm)| {
            let name = labels.get("dimension").and_then(|value| value.as_str())?;
            if !name.to_uppercase().starts_with("FAN") {
                return None;
            }
            Some(serde_json::json!({ "name": name, "rpm": rpm.round() as i64 }))
        })
        .collect();
    rows.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    let zone_rows: Vec<serde_json::Value> = zones
        .into_iter()
        .map(|(labels, level)| {
            let zone = labels
                .get("zone")
                .or_else(|| labels.get("type"))
                .and_then(|value| value.as_str())
                .unwrap_or("?")
                .to_string();
            serde_json::json!({ "zone": zone, "level_pct": level.round() as i64 })
        })
        .collect();
    axum::Json(serde_json::json!({
        "fans": rows,
        "zones": zone_rows,
        "fan_max_rpm": ceilings.values().cloned().fold(f64::NAN, f64::max) as i64,
        "source": "netdata IPMI via prometheus",
    }))
    .into_response()
}

/// Seconds since the guard last wrote its heartbeat, from the file's own epoch
/// stamp and the kernel uptime — the same arithmetic the guard's peers use.
fn heartbeat_age() -> Option<f64> {
    let stamp = std::fs::read_to_string(HEARTBEAT_PATH).ok()?.trim().parse::<f64>().ok()?;
    let uptime = std::fs::read_to_string("/proc/uptime").ok()?.split_whitespace().next()?.parse::<f64>().ok()?;
    Some(uptime - stamp)
}

/// Every non-comment `KEY=VALUE` in the guard's configuration, as strings, so a
/// card can show sustain/poll/action without a bespoke parser per field.
fn guard_config() -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    if let Ok(text) = std::fs::read_to_string(GUARD_CONF) {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') || !line.contains('=') {
                continue;
            }
            let (key, value) = line.split_once('=').unwrap_or((line, ""));
            let value = value.trim().trim_matches('"');
            if !value.is_empty() {
                out.insert(key.trim().to_string(), serde_json::json!(value));
            }
        }
    }
    out
}

fn guard_thresholds() -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    if let Ok(text) = std::fs::read_to_string(GUARD_CONF) {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') || !line.contains('=') {
                continue;
            }
            let (key, value) = line.split_once('=').unwrap_or((line, ""));
            let key = key.trim();
            if key.ends_with("_WARN") || key.ends_with("_CRIT") {
                if let Ok(number) = value.trim().split_whitespace().next().unwrap_or("").parse::<f64>() {
                    out.insert(key.to_string(), serde_json::json!(number));
                }
            }
        }
    }
    out
}

/// The thermal guard's latch and heartbeat plus the protection units' states.
async fn host_protection() -> axum::response::Response {
    let latch = std::fs::metadata(LATCH_PATH).is_ok();
    let latch_detail = if latch {
        std::fs::read_to_string(LATCH_PATH).unwrap_or_default().trim().to_string()
    } else {
        String::new()
    };
    let age = heartbeat_age();
    let units = tokio::task::spawn_blocking(|| {
        PROTECTION_UNITS
            .iter()
            .map(|unit| {
                let state = std::process::Command::new("systemctl")
                    .args(["is-active", unit])
                    .output()
                    .ok()
                    .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "unknown".into());
                let enabled = std::process::Command::new("systemctl")
                    .args(["is-enabled", unit])
                    .output()
                    .ok()
                    .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                    .unwrap_or_else(|| "unknown".into());
                serde_json::json!({ "unit": unit, "active": state, "enabled": enabled })
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();

    // The last thing each safety service said, so its card can show what it is
    // doing rather than only that systemd considers it active.
    // A tail, not a single line: a restart or a trip is a sequence, and one line of
    // it says almost nothing.
    let tail = |unit: &'static str, count: usize| async move {
        tokio::task::spawn_blocking(move || {
            let output = std::process::Command::new("journalctl")
                .args(["-u", unit, "-n", &count.to_string(), "--no-pager", "-o", "short-iso"])
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some(
                text.lines()
                    .map(|line| line.chars().take(240).collect::<String>())
                    .collect::<Vec<_>>(),
            )
        })
        .await
        .ok()
        .flatten()
    };
    let last_line = |unit: &'static str| async move {
        tokio::task::spawn_blocking(move || {
            let output = std::process::Command::new("journalctl")
                .args(["-u", unit, "-n", "1", "--no-pager", "-o", "cat"])
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if text.is_empty() { None } else { Some(text.chars().take(160).collect::<String>()) }
        })
        .await
        .ok()
        .flatten()
    };
    let c80_line = last_line("smfc-c80-monitor").await;
    let c80_lines = tail("smfc-c80-monitor", 20).await;
    let guard_lines = tail("cmp-gpu-guard", 20).await;
    let smfc_lines = tail("smfc", 10).await;
    let c80_marker = std::path::Path::new(C80_MARKER).exists();
    let warning_line = tokio::task::spawn_blocking(|| journal_last("cmp-gpu-guard", "WARNING")).await.ok().flatten();
    let critical_line = tokio::task::spawn_blocking(|| journal_last("cmp-gpu-guard", "CRITICAL")).await.ok().flatten();
    let guard_conf = guard_config();
    let guard_line = last_line("cmp-gpu-guard").await;
    let smfc_line = last_line("smfc").await;

    let healthy = !latch && age.map(|seconds| seconds <= 45.0).unwrap_or(false)
        && units.iter().all(|unit| unit["active"] == "active");
    axum::Json(serde_json::json!({
        "healthy": healthy,
        "latch": latch,
        "latch_detail": latch_detail,
        "guard_heartbeat_age_s": age.map(|value| (value * 10.0).round() / 10.0),
        "thresholds": guard_thresholds(),
        "units": units,
        "c80": {
            "last_line": c80_line,
            "lines": c80_lines,
            "marker": c80_marker,
            "restore_marker": C80_MARKER,
        },
        "guard": {
            "last_line": guard_line,
            "heartbeat_age_s": age.map(|value| (value * 10.0).round() / 10.0),
            "config": guard_conf,
            "last_warning": warning_line,
            "last_critical": critical_line,
            "lines": guard_lines,
        },
        "smfc": { "last_line": smfc_line, "lines": smfc_lines },
    }))
    .into_response()
}


// ── router status (read-only) ───────────────────────────────────────────────
// The router is the routing implementation; this only reads it. `/router/status`
// carries the backend inventory, `/healthz` the routing mode and session count,
// and the panel wants both in one same-origin response.

const ROUTER_BASE: &str = "http://127.0.0.1:18030";

async fn router_json(path: &str) -> Option<serde_json::Value> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .ok()?;
    let text = client.get(format!("{ROUTER_BASE}{path}")).send().await.ok()?.text().await.ok()?;
    serde_json::from_str(&text).ok()
}

async fn host_router() -> axum::response::Response {
    let status = router_json("/router/status").await;
    let health = router_json("/healthz").await;
    let Some(status) = status else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({ "error": "router unreachable", "router": ROUTER_BASE })),
        )
            .into_response();
    };

    // Pass the router's backend objects through unchanged. Rebuilding them field by
    // field silently dropped what the router does report (vram, queues, kv cache,
    // sampled_at) and made this proxy a second, narrower schema.
    let backends: Vec<serde_json::Value> = status
        .get("backends")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    axum::Json(serde_json::json!({
        "backends": backends,
        "auth_mode": health.as_ref().and_then(|h| h.get("auth_mode")).cloned().unwrap_or(serde_json::Value::Null),
        "affinity_mode": health.as_ref().and_then(|h| h.get("affinity_mode")).cloned().unwrap_or(serde_json::Value::Null),
        "sessions": health.as_ref().and_then(|h| h.get("sessions")).cloned().unwrap_or(serde_json::Value::Null),
        "sampled_at": status.get("sampled_at").cloned().unwrap_or(serde_json::Value::Null),
    }))
    .into_response()
}


// ── cooling data (read-only) ────────────────────────────────────────────────
// Cooling facts that NVML does not carry: smfc's zone arbitration, the IPMI fan
// tachometers and the HBM sensors Netdata publishes. Read-only, from exporters
// that already run.

/// One PromQL range query as a `(labels, points)` series list.
async fn promql_range(query: &str, window_s: i64) -> Vec<(serde_json::Map<String, serde_json::Value>, Vec<[f64; 2]>)> {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(6)).build() {
        Ok(client) => client,
        Err(_) => return Vec::new(),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let step = (window_s / 120).max(15);
    let url = format!(
        "{PROMETHEUS}/api/v1/query_range?query={query}&start={}&end={now}&step={step}",
        now - window_s
    );
    let text = match client.get(url).send().await {
        Ok(response) => match response.text().await {
            Ok(text) => text,
            Err(_) => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    let body: serde_json::Value = match serde_json::from_str(&text) {
        Ok(body) => body,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    if let Some(results) = body.pointer("/data/result").and_then(|value| value.as_array()) {
        for result in results {
            let labels = result
                .get("metric")
                .and_then(|value| value.as_object())
                .cloned()
                .unwrap_or_default();
            let points: Vec<[f64; 2]> = result
                .get("values")
                .and_then(|value| value.as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|pair| {
                            let ts = pair.get(0)?.as_f64()?;
                            let value = pair.get(1)?.as_str()?.parse::<f64>().ok()?;
                            Some([ts, value])
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !points.is_empty() {
                out.push((labels, points));
            }
        }
    }
    out
}

/// smfc's own view: exporter up, whether it holds the fans, zone levels and the
/// temperature each zone is reacting to.
async fn host_cooling() -> axum::response::Response {
    let up = promql("smfc_up").await;
    let held = promql("smfc_fan_control_held").await;
    let levels = promql("smfc_zone_level_percent").await;
    let temps = promql("smfc_controller_temperature_celsius").await;

    let zones: Vec<serde_json::Value> = levels
        .iter()
        .map(|(labels, level)| {
            let zone = labels
                .get("zone")
                .and_then(|value| value.as_str())
                .unwrap_or("?")
                .to_string();
            let temperature = temps
                .iter()
                .find(|(other, _)| other.get("zone").and_then(|value| value.as_str()) == Some(zone.as_str()))
                .map(|(_, value)| *value);
            serde_json::json!({
                "zone": zone,
                "level_pct": level.round() as i64,
                "temperature_c": temperature.map(|value| (value * 10.0).round() / 10.0),
            })
        })
        .collect();

    axum::Json(serde_json::json!({
        "smfc_up": up.first().map(|(_, value)| *value > 0.0).unwrap_or(false),
        "control_held": held.first().map(|(_, value)| *value > 0.0),
        "zones": zones,
    }))
    .into_response()
}

/// History for the three cooling series that have no native panel: HBM
/// temperature, fan RPM and chassis temperature.
async fn host_thermal_history(axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>) -> axum::response::Response {
    let metric = params.get("metric").map(String::as_str).unwrap_or("hbm");
    let window = params
        .get("window")
        .and_then(|value| match value.as_str() {
            "5m" => Some(300),
            "10m" => Some(600),
            "15m" => Some(900),
            "1h" => Some(3_600),
            "6h" => Some(21_600),
            "24h" => Some(86_400),
            "7d" => Some(604_800),
            _ => None,
        })
        .unwrap_or(900);
    let (query, unit) = match metric {
        "fans" => ("netdata_cmpipmi_fans_RPM_average", "rpm"),
        "chassis" => ("netdata_cmpipmi_temps_Celsius_average", "C"),
        "inlet" => ("netdata_cmpipmi_temps_Celsius_average", "C"),
        "duty" => ("smfc_zone_level_percent", "%"),
        "power_total" => ("sum(netdata_nvidia_smi_gpu_power_draw_Watts_average)", "W"),
        _ => ("netdata_cmpgpu_memtemp_Celsius_average", "C"),
    };

    // UUID -> index, so HBM series carry the same names as the cards.
    let uuid_map: std::collections::HashMap<String, u32> = tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("nvidia-smi")
            .args(["--query-gpu=index,uuid", "--format=csv,noheader"])
            .output();
        let mut map = std::collections::HashMap::new();
        if let Ok(output) = output {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if let Some((index, uuid)) = line.split_once(',') {
                    if let (Ok(index), Ok(uuid)) = (index.trim().parse::<u32>(), Ok::<&str, ()>(uuid.trim())) {
                        map.insert(uuid.to_string(), index);
                    }
                }
            }
        }
        map
    })
    .await
    .unwrap_or_default();

    let mut results = promql_range(query, window).await;
    if metric == "inlet" {
        // Only the sensor the summary reports. Filtered before the map because a
        // closure cannot `continue`.
        results.retain(|(labels, _)| {
            labels.get("dimension").and_then(|value| value.as_str()) == Some("System Temp")
        });
    }
    let mut series: Vec<serde_json::Value> = results
        .into_iter()
        .map(|(labels, points)| {
            // Netdata labels the HBM series by UUID inside the chart name; map it
            // back to the GPU index the operator sees, not "memory".
            let chart = labels.get("chart").and_then(|value| value.as_str()).unwrap_or("");
            let name = if metric == "inlet" {
                "System Temp".to_string()
            } else if metric == "duty" {
                format!("zone {}", labels.get("zone").and_then(|v| v.as_str()).unwrap_or("?"))
            } else if metric == "power_total" {
                "GPU total".to_string()
            } else if metric == "hbm" {
                // Netdata names three of the four memtemp charts after their UUID
                // and the fourth plainly `cmpgpu.memtemp`; that plain chart is
                // GPU 0's junction, not an average of the cards.
                chart
                    .find("GPU-")
                    .and_then(|start| chart.get(start..start + 40))
                    .and_then(|uuid| uuid_map.get(uuid).map(|index| format!("GPU {index}")))
                    .unwrap_or_else(|| "GPU 0".to_string())
            } else {
                labels
                    .get("dimension")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| "series".into())
            };
            serde_json::json!({ "name": name, "unit": unit, "points": points })
        })
        .collect();

    // Fans only: Prometheus also stores a synthetic "slowest fan" dimension, and a
    // legend line for it reads as a fan that does not exist. Then sort so a GPU's
    // colour does not change between polls.
    if metric == "fans" {
        series.retain(|entry| {
            entry["name"]
                .as_str()
                .map(|name| name.to_uppercase().starts_with("FAN"))
                .unwrap_or(false)
        });
    }
    series.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));

    axum::Json(serde_json::json!({ "series": series, "unit": unit })).into_response()
}


// ── HBM junction temperature (read-only) ────────────────────────────────────
// The NVML wrapper in use wraps only the die sensor, so the memory junction is
// read from nvidia-smi. Cached briefly: a page with four cards should not spawn
// four processes per poll.

static HBM_CACHE: std::sync::Mutex<Option<(std::time::Instant, serde_json::Value)>> =
    std::sync::Mutex::new(None);

async fn host_hbm() -> axum::response::Response {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    let cache: &Mutex<Option<(Instant, serde_json::Value)>> = &HBM_CACHE;
    if let Ok(guard) = cache.lock() {
        if let Some((at, value)) = guard.as_ref() {
            if at.elapsed() < Duration::from_secs(5) {
                return axum::Json(value.clone()).into_response();
            }
        }
    }

    let gpus = tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("nvidia-smi")
            .args([
                "--query-gpu=index,temperature.memory",
                "--format=csv,noheader,nounits",
            ])
            .output();
        let Ok(output) = output else { return Vec::new() };
        if !output.status.success() {
            return Vec::new();
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let (index, value) = line.split_once(',')?;
                let index: u32 = index.trim().parse().ok()?;
                let value: f64 = value.trim().parse().ok()?;
                Some(serde_json::json!({ "index": index, "hbm_c": value }))
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();

    let body = serde_json::json!({ "gpus": gpus });
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((Instant::now(), body.clone()));
    }
    axum::Json(body).into_response()
}


// ── smfc fan curve (read-only) ──────────────────────────────────────────────
// The curve smfc is actually applying, plus the point it is operating at. The
// curve comes from /etc/smfc/smfc.conf (control_function=C-F pairs) and the live
// point from its exporter.

const SMFC_CONF: &str = "/etc/smfc/smfc.conf";

fn smfc_curve() -> Vec<[f64; 2]> {
    let Ok(text) = std::fs::read_to_string(SMFC_CONF) else {
        return Vec::new();
    };
    let Some(line) = text.lines().find(|line| line.trim_start().starts_with("control_function")) else {
        return Vec::new();
    };
    let Some((_, values)) = line.split_once('=') else {
        return Vec::new();
    };
    values
        .split(',')
        .filter_map(|pair| {
            let (temperature, level) = pair.trim().split_once('-')?;
            Some([temperature.trim().parse().ok()?, level.trim().parse().ok()?])
        })
        .collect()
}

async fn host_fan_curve() -> axum::response::Response {
    let curve = tokio::task::spawn_blocking(smfc_curve).await.unwrap_or_default();
    let levels = promql("smfc_zone_level_percent").await;
    let temps = promql("smfc_controller_temperature_celsius").await;
    // The GPU zone is the one carrying the cards; pick the highest temperature it
    // is reacting to and the level it currently commands.
    let live_temp = temps.iter().map(|(_, value)| *value).fold(f64::NAN, f64::max);
    let live_level = levels
        .iter()
        .filter(|(labels, _)| labels.get("zone").and_then(|value| value.as_str()) == Some("1"))
        .map(|(_, value)| *value)
        .next()
        .or_else(|| levels.first().map(|(_, value)| *value));

    // The fans that are actually spinning right now, so a point on the curve can be
    // read together with the airflow it is producing.
    let rpm_rows: Vec<f64> = promql("netdata_cmpipmi_fans_RPM_average")
        .await
        .into_iter()
        .filter(|(labels, _)| {
            labels
                .get("dimension")
                .and_then(|value| value.as_str())
                .map(|name| name.to_uppercase().starts_with("FAN"))
                .unwrap_or(false)
        })
        .map(|(_, value)| value)
        .collect();
    let rpm_total: f64 = rpm_rows.iter().sum();
    let rpm_min = rpm_rows.iter().cloned().fold(f64::INFINITY, f64::min);
    let rpm_max = rpm_rows.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    axum::Json(serde_json::json!({
        "curve": curve,
        "rpm": {
            "count": rpm_rows.len(),
            "total": if rpm_rows.is_empty() { serde_json::Value::Null } else { serde_json::json!(rpm_total.round() as i64) },
            "min": if rpm_rows.is_empty() { serde_json::Value::Null } else { serde_json::json!(rpm_min.round() as i64) },
            "max": if rpm_rows.is_empty() { serde_json::Value::Null } else { serde_json::json!(rpm_max.round() as i64) },
        },
        "live": {
            "temperature_c": if live_temp.is_nan() { serde_json::Value::Null } else { serde_json::json!((live_temp * 10.0).round() / 10.0) },
            "level_pct": live_level.map(|value| value.round() as i64),
        },
    }))
    .into_response()
}


// ── cooling summary (read-only) ─────────────────────────────────────────────
// The numbers the legacy cooling page led with: hottest junction, fan duty, inlet
// temperature, guard events over a day, and the states that explain them.

const C80_MARKER: &str = "/run/smfc-c80-restored";

fn journal_count(unit: &str, pattern: &str, since: &str) -> Option<u32> {
    let output = std::process::Command::new("journalctl")
        .args(["-u", unit, "--since", since, "-o", "cat", "--no-pager"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    Some(text.lines().filter(|line| line.contains(pattern)).count() as u32)
}

fn journal_last(unit: &str, pattern: &str) -> Option<String> {
    let output = std::process::Command::new("journalctl")
        .args(["-u", unit, "-o", "cat", "--no-pager"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .rev()
        .find(|line| line.contains(pattern))
        .map(|line| line.chars().take(160).collect())
}


/// Sum of the cards' current draw, straight from NVML. One process per poll.
fn gpu_power_total() -> Option<f64> {
    let output = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=power.draw", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let total: f64 = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<f64>().ok())
        .sum();
    Some((total * 10.0).round() / 10.0)
}

async fn host_cooling_summary() -> axum::response::Response {
    // fan duty: the zone smfc is driving hardest, and the highest RPM seen in 24 h
    let zones = promql("smfc_zone_level_percent").await;
    let duty = zones.iter().map(|(_, value)| *value).fold(f64::NAN, f64::max);
    // fan_max was a 24 h max that no panel reads; keep the field stable but cheap.
    let fan_max: Option<f64> = None;
    let fans = promql("netdata_cmpipmi_fans_RPM_average").await;

    // hottest junction across the cards (Netdata publishes all four memtemp charts)
    let hbm = promql("netdata_cmpgpu_memtemp_Celsius_average").await;
    let hottest = hbm
        .iter()
        .filter(|(labels, _)| labels.get("chart").and_then(|v| v.as_str()).map(|c| c.contains("GPU-") || c.ends_with("memtemp")).unwrap_or(false))
        .map(|(_, value)| *value)
        .fold(f64::NAN, f64::max);

    // inlet: the "System Temp" IPMI sensor
    let inlet = promql("netdata_cmpipmi_temps_Celsius_average")
        .await
        .into_iter()
        .find(|(labels, _)| labels.get("dimension").and_then(|v| v.as_str()) == Some("System Temp"))
        .map(|(_, value)| value);

    let units = promql("smfc_up").await;
    let held = promql("smfc_fan_control_held").await;
    let curve = tokio::task::spawn_blocking(smfc_curve).await.unwrap_or_default();

    let guard_active = std::process::Command::new("systemctl")
        .args(["is-active", "cmp-gpu-guard"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "active")
        .unwrap_or(false);
    let c80_active = std::process::Command::new("systemctl")
        .args(["is-active", "smfc-c80-monitor"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "active")
        .unwrap_or(false);

    let warnings = tokio::task::spawn_blocking(|| journal_count("cmp-gpu-guard", "WARNING", "24 hours ago"))
        .await
        .ok()
        .flatten();
    let criticals = tokio::task::spawn_blocking(|| journal_count("cmp-gpu-guard", "CRITICAL", "24 hours ago"))
        .await
        .ok()
        .flatten();

    axum::Json(serde_json::json!({
        "hottest_hbm_c": if hottest.is_nan() { serde_json::Value::Null } else { serde_json::json!((hottest * 10.0).round() / 10.0) },
        "hbm_ceiling_c": guard_thresholds().get("HBM_CRIT").and_then(|value| value.as_f64()),
        "fan_duty_pct": if duty.is_nan() { serde_json::Value::Null } else { serde_json::json!(duty.round() as i64) },
        "zone_count": zones.len(),
        // Removed: a 24 h ceiling no panel consumed (the UI reads fan_now_max_rpm).
        "fan_max_rpm": serde_json::Value::Null,
        "fan_now_max_rpm": fans.iter().map(|(_, value)| *value).fold(0.0, f64::max).round() as i64,
        "inlet_c": inlet.map(|value| (value * 10.0).round() / 10.0),
        "guard_warnings_24h": warnings,
        "guard_criticals_24h": criticals,
        "profile": "C_80",
        "fan_ownership": if held.first().map(|(_, value)| *value > 0.0).unwrap_or(false) { "HELD" } else { "RELEASED" },
        "smfc_active": units.first().map(|(_, value)| *value > 0.0).unwrap_or(false),
        "guard_active": guard_active,
        "watchdog_armed": c80_active && !std::path::Path::new(C80_MARKER).exists(),
        "curve_points": curve.len(),
        "gpu_power_total_w": gpu_power_total(),
    }))
    .into_response()
}


// ── router history (sampled in-process) ─────────────────────────────────────
// The router reports counters, not series. Sampling its own status into a bounded
// ring is the smallest honest way to plot a rate: every point is a real reading and
// a Spark restart simply starts a new window.

static ROUTER_SAMPLES: std::sync::Mutex<Vec<serde_json::Value>> = std::sync::Mutex::new(Vec::new());
const ROUTER_SAMPLE_MAX: usize = 120;

async fn router_status_body() -> Option<serde_json::Value> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .ok()?;
    let text = client
        .get(format!("{ROUTER_BASE}/router/status"))
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    serde_json::from_str(&text).ok()
}

fn record_router_sample(body: &serde_json::Value) -> Option<()> {
    let backends = body.get("backends")?.as_array()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let served: u64 = backends
        .iter()
        .filter_map(|b| b.get("requests_served").and_then(|v| v.as_u64()))
        .sum();
    let in_flight: u64 = backends
        .iter()
        .filter_map(|b| {
            b.get("router_in_flight")
                .or_else(|| b.get("in_flight"))
                .and_then(|v| v.as_u64())
        })
        .sum();
    let ready = backends
        .iter()
        .filter(|b| b.get("healthy").and_then(|v| v.as_bool()).unwrap_or(false))
        .count();
    let draining = backends
        .iter()
        .filter(|b| b.get("draining").and_then(|v| v.as_bool()).unwrap_or(false))
        .count();
    let sample = serde_json::json!({
        "t": now,
        "served": served,
        "in_flight": in_flight,
        "ready": ready,
        "draining": draining,
    });
    if let Ok(mut samples) = ROUTER_SAMPLES.lock() {
        samples.push(sample);
        let excess = samples.len().saturating_sub(ROUTER_SAMPLE_MAX);
        if excess > 0 {
            samples.drain(0..excess);
        }
    }
    Some(())
}

async fn host_router_history(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    if let Some(body) = router_status_body().await {
        record_router_sample(&body);
    }
    // Sample-bounded, not time-bounded: the last `limit` router polls. This is a
    // process-local ring, so advertising 6h/24h windows was a lie whenever the
    // dashboard restarted; a count is what the data can actually honour.
    let limit = params
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(100)
        .clamp(2, ROUTER_SAMPLE_MAX);
    let samples = ROUTER_SAMPLES.lock().map(|s| s.clone()).unwrap_or_default();
    let windowed: Vec<&serde_json::Value> = samples.iter().skip(samples.len().saturating_sub(limit)).collect();
    if windowed.len() < 2 {
        return axum::Json(serde_json::json!({ "series": [], "thresholds": [] })).into_response();
    }

    let mut rate = Vec::new();
    let mut in_flight = Vec::new();
    let mut ready = Vec::new();
    for pair in windowed.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let dt = (b["t"].as_u64().unwrap_or(0)).saturating_sub(a["t"].as_u64().unwrap_or(0)).max(1) as f64;
        let ds = (b["served"].as_u64().unwrap_or(0)).saturating_sub(a["served"].as_u64().unwrap_or(0)) as f64;
        rate.push(serde_json::json!([b["t"], (ds / dt * 100.0).round() / 100.0]));
        in_flight.push(serde_json::json!([b["t"], b["in_flight"]]));
        ready.push(serde_json::json!([b["t"], b["ready"]]));
    }

    axum::Json(serde_json::json!({
        "series": [
            { "name": "requests/s", "unit": "/s", "points": rate },
            { "name": "in flight", "unit": "req", "axis": "right", "points": in_flight },
            { "name": "ready backends", "unit": "", "axis": "right", "points": ready },
        ],
        "thresholds": [],
    }))
    .into_response()
}


/// One router backend, as the router reports it, plus the routing modes.
async fn host_router_backend(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let Some(name) = params.get("name").filter(|value| !value.is_empty()) else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({ "error": "name is required" })),
        )
            .into_response();
    };
    let Some(body) = router_status_body().await else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({ "error": "router unreachable" })),
        )
            .into_response();
    };
    let backend = body
        .get("backends")
        .and_then(|value| value.as_array())
        .and_then(|rows| rows.iter().find(|row| row.get("name").and_then(|v| v.as_str()) == Some(name.as_str())))
        .cloned();
    match backend {
        Some(backend) => axum::Json(serde_json::json!({
            "backend": backend,
            "auth_mode": body.get("auth_mode"),
            "affinity_mode": body.get("affinity_mode"),
            "sessions": body.get("sessions"),
            "sampled_at": body.get("sampled_at"),
        }))
        .into_response(),
        None => (
            axum::http::StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({ "error": format!("router has no backend named {name}") })),
        )
            .into_response(),
    }
}


/// Drain or undrain one backend through the router's own admin endpoint. The router
/// owns the state; this only forwards it, so the page cannot disagree with reality.
async fn host_router_drain(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let Some(name) = params.get("name").filter(|value| !value.is_empty()) else {
        return (axum::http::StatusCode::BAD_REQUEST, "name is required").into_response();
    };
    let on = params.get("on").map(|value| value == "true").unwrap_or(true);
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(client) => client,
        Err(_) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "http client").into_response(),
    };
    // The router types `on` as an int (1/0), not a bool; `on=false` is a 422.
    let flag = if on { 1 } else { 0 };
    let url = format!("{ROUTER_BASE}/router/admin/drain/{name}?on={flag}");
    match client.post(url).send().await {
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            (
                axum::http::StatusCode::from_u16(status.as_u16()).unwrap_or(axum::http::StatusCode::BAD_GATEWAY),
                body,
            )
                .into_response()
        }
        Err(_) => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "router unreachable").into_response(),
    }
}


// ── model lab (Xinference is the manager; this is a surface over it) ────────
const PROFILES_DIR: &str = "/etc/xinference/profiles";

fn profile_catalog() -> Vec<serde_json::Value> {
    let mut profiles = Vec::new();
    let Ok(entries) = std::fs::read_dir(PROFILES_DIR) else {
        return profiles;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(document) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(name) = document.get("profile").and_then(|value| value.as_str()) else { continue };
        let launch = document.get("launch").cloned().unwrap_or_default();
        let mut names = vec![name.to_string()];
        if let Some(model_name) = launch.get("model_name").and_then(|value| value.as_str()) {
            names.push(model_name.to_string());
        }
        for alias in document.get("aliases").and_then(|value| value.as_array()).into_iter().flatten() {
            if let Some(alias) = alias.as_str() {
                names.push(alias.to_string());
            }
        }
        profiles.push(serde_json::json!({
            "profile": name,
            "names": names,
            "context": launch.get("max_model_len").and_then(|value| value.as_u64()),
        }));
    }
    profiles
}

fn profile_for_loaded(model: &serde_json::Value, profiles: &[serde_json::Value]) -> Option<String> {
    let uid = model.get("uid").and_then(|value| value.as_str());
    let name = model.get("model_name").and_then(|value| value.as_str());
    let context = model.get("context_length").and_then(|value| value.as_u64());
    // Exact runtime UID/profile alias wins.
    for profile in profiles {
        let names = profile.get("names").and_then(|value| value.as_array())?;
        if uid.is_some() && names.iter().any(|value| value.as_str() == uid) {
            return profile.get("profile").and_then(|value| value.as_str()).map(str::to_string);
        }
    }
    // Shared model names are differentiated by their applied context.
    let matches: Vec<&serde_json::Value> = profiles
        .iter()
        .filter(|profile| {
            let Some(names) = profile.get("names").and_then(|value| value.as_array()) else {
                return false;
            };
            let name_match = name.is_some() && names.iter().any(|value| value.as_str() == name);
            let context_match = context.is_some()
                && profile.get("context").and_then(|value| value.as_u64()) == context;
            name_match && context_match
        })
        .collect();
    if matches.len() == 1 {
        matches[0].get("profile").and_then(|value| value.as_str()).map(str::to_string)
    } else {
        None
    }
}


async fn host_model_profiles() -> axum::response::Response {
    // The bridge owns the loadable configs; Spark must not keep a second copy.
    if let Ok(response) = reqwest::get("http://127.0.0.1:9997/extensions/spark-bridge/configs").await {
        if let Ok(body) = response.json::<serde_json::Value>().await {
            if let Some(configs) = body.get("configs").and_then(|value| value.as_array()) {
                if !configs.is_empty() {
                    let profiles: Vec<serde_json::Value> = configs
                        .iter()
                        .map(|config| {
                            let launch = config.get("launch").cloned().unwrap_or_default();
                            let drafter = launch
                                .get("speculative_config")
                                .and_then(|value| value.get("model"))
                                .and_then(|value| value.as_str())
                                .unwrap_or("")
                                .rsplit('/')
                                .next()
                                .unwrap_or("");
                            serde_json::json!({
                                "profile": config.get("profile"),
                                "gpu": config.get("gpu"),
                                "model_uid": config.get("model_uid"),
                                "aliases": config.get("aliases"),
                                "external": launch.get("device").and_then(|value| value.as_str()) == Some("cpu")
                                    || launch.get("model_engine").and_then(|value| value.as_str()) == Some("Morrowmake"),
                                "validated": config.get("validation").and_then(|v| v.get("xinference_inference")).and_then(|v| v.as_bool()).unwrap_or(false),
                                "validation": config.get("validation"),
                                "notes": config.get("validation").and_then(|v| v.get("notes")),
                                "model_name": launch.get("model_name"),
                                "max_model_len": launch.get("max_model_len"),
                                "speculative": launch.get("speculative_config").and_then(|v| v.get("method")),
                                "drafter": drafter,
                            })
                        })
                        .collect();
                    return axum::Json(serde_json::json!({ "profiles": profiles, "source": "bridge" })).into_response();
                }
            }
        }
    }
    let mut profiles = Vec::new();
    if let Ok(entries) = std::fs::read_dir(PROFILES_DIR) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let Ok(document) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            let launch = document.get("launch").cloned().unwrap_or_default();
            profiles.push(serde_json::json!({
                "profile": document.get("profile"),
                "validated": document.get("validated"),
                "notes": document.get("notes"),
                "model_uid": document.get("model_uid"),
                "model_name": launch.get("model_name"),
                "max_model_len": launch.get("max_model_len"),
                "speculative": launch.get("speculative_config").and_then(|config| config.get("method")),
                "drafter": launch.get("speculative_config").and_then(|config| config.get("model")),
            }));
        }
    }
    profiles.sort_by(|left, right| {
        left["profile"].as_str().cmp(&right["profile"].as_str())
    });
    axum::Json(serde_json::json!({ "profiles": profiles })).into_response()
}

/// Live models, as the bridge sees them (uid, status, GPU index/UUID, memory).
async fn host_models() -> axum::response::Response {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "http client").into_response(),
    };
    match client
        .get("http://127.0.0.1:9997/extensions/spark-bridge/models")
        .send()
        .await
    {
        Ok(response) => match response.text().await {
            Ok(text) => {
                let mut value: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    // An unreadable bridge body is an upstream failure, not an empty
                    // inventory: reporting 200/[] hides the outage from every panel.
                    Err(_) => {
                        return (axum::http::StatusCode::BAD_GATEWAY, "bridge returned unparsable models")
                            .into_response()
                    }
                };
                // Identity comes from the engine. The bridge is being taught to carry
                // these fields; until the running Xinference process is restarted we
                // read the same facts from Xinference's own model detail endpoint.
                let uids: Vec<String> = value
                    .get("models")
                    .and_then(|rows| rows.as_array())
                    .map(|rows| {
                        rows.iter()
                            .filter_map(|row| row.get("uid").and_then(|v| v.as_str()).map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(3))
                    .build()
                    .ok();
                // One router read for the whole inventory. This used to be inside the
                // per-uid loop, turning one /api/models call into N+1 upstream reads.
                let router_backends = router_json("/router/status")
                    .await
                    .and_then(|status| status.get("backends").and_then(|rows| rows.as_array()).cloned())
                    .unwrap_or_default();
                if let Some(client) = client {
                    for uid in uids {
                        // The router bound is the number that actually gates requests and
                        // it is authoritative even when the bridge already reports a
                        // context (Xinference's detail field is registration-level, not
                        // the running launch value).
                        let router_ctx = router_backends
                            .iter()
                            .find(|row| row.get("model_uid").and_then(|v| v.as_str()) == Some(uid.as_str()))
                            .and_then(|row| row.get("max_ctx_resolved"))
                            .cloned();
                        if let (Some(ctx), Some(row)) = (
                            router_ctx.clone(),
                            value
                                .get_mut("models")
                                .and_then(|rows| rows.as_array_mut())
                                .and_then(|rows| rows.iter_mut().find(|row| row.get("uid").and_then(|v| v.as_str()) == Some(uid.as_str()))),
                        ) {
                            row["context_length"] = ctx;
                        }
                        let missing = value
                            .get("models")
                            .and_then(|rows| rows.as_array())
                            .and_then(|rows| rows.iter().find(|row| row.get("uid").and_then(|v| v.as_str()) == Some(uid.as_str())))
                            .and_then(|row| row.get("context_length"))
                            .is_none();
                        if !missing {
                            continue;
                        }
                        let Ok(response) = client.get(format!("http://127.0.0.1:9997/v1/models/{uid}")).send().await else { continue };
                        let Ok(detail) = response.json::<serde_json::Value>().await else { continue };
                        // Router first (the bound that gates requests); the engine's own
                        // registration context is a real fallback, not a blank field,
                        // when the router is unreachable.
                        let running_ctx = router_ctx.or_else(|| detail.get("context_length").cloned());
                        if let Some(row) = value
                            .get_mut("models")
                            .and_then(|rows| rows.as_array_mut())
                            .and_then(|rows| rows.iter_mut().find(|row| row.get("uid").and_then(|v| v.as_str()) == Some(uid.as_str())))
                        {
                            if let Some(ctx) = running_ctx.clone() {
                                row["context_length"] = ctx;
                            }
                            for key in ["model_engine", "quantization", "model_format"] {
                                if let Some(field) = detail.get(key) {
                                    row[key] = field.clone();
                                }
                            }
                        }
                    }
                }
                // Loaded rows carry the actual profile identity only when it can
                // be resolved uniquely from model + applied context.
                let profiles = profile_catalog();
                if let Some(rows) = value
                    .get_mut("models")
                    .and_then(|rows| rows.as_array_mut())
                {
                    for row in rows {
                        let profile = profile_for_loaded(row, &profiles);
                        if let Some(profile) = profile {
                            row["profile"] = serde_json::Value::String(profile);
                        } else if let Some(object) = row.as_object_mut() {
                            object.remove("profile");
                        }
                    }
                }
                ([(axum::http::header::CONTENT_TYPE, "application/json")], value.to_string()).into_response()
            }
            Err(_) => (axum::http::StatusCode::BAD_GATEWAY, "bridge read failed").into_response(),
        },
        Err(_) => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "xinference unreachable").into_response(),
    }
}

async fn gpu_occupant(gpu: u32) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;
    let response = client
        .get("http://127.0.0.1:9997/extensions/spark-bridge/models")
        .send()
        .await
        .ok()?;
    let body = response.json::<serde_json::Value>().await.ok()?;
    body.get("models")
        .and_then(|rows| rows.as_array())
        .and_then(|rows| {
            rows.iter().find_map(|model| {
                let status = model.get("status").and_then(|value| value.as_str());
                let index = model
                    .get("gpu_index")
                    .and_then(|value| {
                        value.as_u64().or_else(|| {
                            value.as_str().and_then(|text| text.parse::<u64>().ok())
                        })
                    })
                    .map(|value| value as u32);
                if status == Some("READY") && index == Some(gpu) {
                    model
                        .get("uid")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                } else {
                    None
                }
            })
        })
}

async fn host_model_load(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let Some(profile_arg) = params.get("profile").filter(|value| !value.is_empty()) else {
        return (axum::http::StatusCode::BAD_REQUEST, "profile is required").into_response();
    };
    // Old web bookmarks used GPU-named profile IDs. Keep those loadable while
    // the catalog itself presents only GPU-agnostic profile identities.
    let profile = match profile_arg.as_str() {
        "gpu0-163840" => "qwen38-autoround-160k",
        "gpu1-262144" | "gpu2-262144" => "qwen38-autoround-256k",
        "gpu3-524288" => "qwen38-autoround-512k",
        other => other,
    };
    if !profile
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'))
        || profile.contains("..")
    {
        return (axum::http::StatusCode::BAD_REQUEST, "invalid profile name").into_response();
    }
    let gpu: u32 = params
        .get("gpu")
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    if gpu > 3 {
        return (axum::http::StatusCode::BAD_REQUEST, "gpu must be 0..3").into_response();
    }
    if let Some(owner) = gpu_occupant(gpu).await {
        return (
            axum::http::StatusCode::CONFLICT,
            format!("GPU {gpu} already has READY model {owner}; unload it first"),
        )
            .into_response();
    }
    let path = format!("{PROFILES_DIR}/{profile}.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (axum::http::StatusCode::NOT_FOUND, "unknown profile").into_response();
    };
    let Ok(document) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "profile unreadable").into_response();
    };
    let mut payload = document.get("launch").cloned().unwrap_or_default();
    if let Some(env) = document.get("env").and_then(|value| value.as_object()) {
        payload["envs"] = serde_json::Value::Object(env.clone());
    }
    // One model per GPU. The UID is the GPU slot, not a profile name, so any
    // profile can be loaded on any GPU without a UID/profile pairing. Preserve
    // the profile's placement: a CPU-attached/external profile (n_gpu null or
    // zero, or device=cpu) must not be forced onto a GPU allocation.
    payload["model_uid"] = serde_json::json!(format!("qwen38-gpu{gpu}"));
    let profile_n_gpu = payload.get("n_gpu").and_then(|v| v.as_u64()).unwrap_or(0);
    let cpu_attached = payload.get("device").and_then(|v| v.as_str()) == Some("cpu") || profile_n_gpu == 0;
    if cpu_attached {
        if let Some(object) = payload.as_object_mut() {
            object.remove("gpu_idx");
            object.insert("n_gpu".to_string(), serde_json::Value::Null);
        }
    } else {
        payload["gpu_idx"] = serde_json::json!([gpu]);
        payload["n_gpu"] = serde_json::json!(1);
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
    {
        Ok(client) => client,
        Err(_) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "http client").into_response(),
    };
    match client
        .post("http://127.0.0.1:9997/v1/models")
        .json(&payload)
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            (
                axum::http::StatusCode::from_u16(status.as_u16()).unwrap_or(axum::http::StatusCode::BAD_GATEWAY),
                body,
            )
                .into_response()
        }
        Err(_) => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "xinference unreachable").into_response(),
    }
}

async fn host_model_unload(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let Some(uid) = params.get("uid").filter(|value| !value.is_empty()) else {
        return (axum::http::StatusCode::BAD_REQUEST, "uid is required").into_response();
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(client) => client,
        Err(_) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "http client").into_response(),
    };
    match client
        .delete(format!("http://127.0.0.1:9997/v1/models/{uid}"))
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            (
                axum::http::StatusCode::from_u16(status.as_u16()).unwrap_or(axum::http::StatusCode::BAD_GATEWAY),
                body,
            )
                .into_response()
        }
        Err(_) => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "xinference unreachable").into_response(),
    }
}


// ── system surfaces (single-admin host: nothing masked) ─────────────────────
const TAILNET: &str = "home-server.tail947b0d.ts.net";

fn fingerprint(path: &str) -> serde_json::Value {
    let meta = std::fs::metadata(path).ok();
    let sha = std::process::Command::new("sha256sum")
        .arg(path)
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .and_then(|text| text.split_whitespace().next().map(str::to_string));
    serde_json::json!({
        "path": path,
        "exists": meta.is_some(),
        "size": meta.as_ref().map(|m| m.len()),
        "sha256": sha,
    })
}

async fn probe_service(
    client: &reqwest::Client,
    id: &str,
    name: &str,
    path: &str,
    link: &str,
    version: Option<(&str, &str)>,
) -> serde_json::Value {
    match client.get(format!("http://127.0.0.1{path}")).send().await {
        Ok(response) => {
            let ok = response.status().is_success();
            let body = response.text().await.unwrap_or_default();
            let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            let version = version.and_then(|(pointer, _)| {
                parsed
                    .pointer(pointer)
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            });
            serde_json::json!({ "id": id, "name": name, "ok": ok, "link": link, "version": version })
        }
        Err(_) => serde_json::json!({ "id": id, "name": name, "ok": false, "link": link, "version": null }),
    }
}

/// The host the operator typed, not 127.0.0.1: a link is opened by the browser, so
/// loopback is the one host that can never be right.
fn public_host(headers: &axum::http::HeaderMap) -> String {
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("192.168.1.145");
    let name = host.split(':').next().unwrap_or("192.168.1.145");
    let name = if name == "127.0.0.1" || name == "localhost" { "192.168.1.145" } else { name };
    name.to_string()
}

async fn host_services(headers: axum::http::HeaderMap) -> axum::response::Response {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok();
    let Some(client) = client else {
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "http client").into_response();
    };
    let mut services = Vec::new();
    services.push(probe_service(&client, "prometheus", "Prometheus", ":9090/-/ready",
        &format!("http://{TAILNET}:9091"), Some(("/data/version", "version"))).await);
    services.push(probe_service(&client, "grafana", "Grafana", ":3000/api/health",
        &format!("http://{TAILNET}:3000"), Some(("/version", "version"))).await);
    services.push(probe_service(&client, "netdata", "Netdata", ":19999/api/v1/info",
        &format!("http://{TAILNET}:19999"), Some(("/version", "version"))).await);
    services.push(probe_service(&client, "xinference", "Xinference", ":9997/v1/models",
        &format!("http://{}:8445/ui", public_host(&headers)), None).await);
    services.push(probe_service(&client, "router", "Router", ":18030/healthz",
        &format!("http://{}:8446/router/status", public_host(&headers)), None).await);
    let caddy = std::process::Command::new("systemctl")
        .args(["is-active", "caddy"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "active")
        .unwrap_or(false);
    services.push(serde_json::json!({ "id": "caddy", "name": "Caddy", "ok": caddy,
        "link": "", "version": null }));
    services.push(serde_json::json!({ "id": "spark", "name": "Spark", "ok": true,
        "link": "", "version": null }));
    axum::Json(serde_json::json!({ "services": services })).into_response()
}

fn read_trim(path: &str) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

async fn host_access() -> axum::response::Response {
    // Client token is the one Caddy accepts at :8443; the engine key is what it
    // replaces it with. Both are read from disk, not from the legacy API.
    let client_token = read_trim("/etc/hyperqwen-control/llm.token")
        .or_else(|| std::fs::read_to_string("/etc/caddy/Caddyfile").ok().and_then(|text| {
            text.split('"').nth(1).map(str::to_string)
        }));
    let engine_key = read_trim("/etc/hyperqwen-control/api_key");
    axum::Json(serde_json::json!({
        "client_token": client_token,
        "engine_key": engine_key,
        "api_base_lan": "https://192.168.1.145:8443/v1",
        "api_base_tailnet": format!("https://{TAILNET}:8443/v1"),
        "dashboard_lan": "https://192.168.1.145:8444",
        "dashboard_tailnet": format!("https://{TAILNET}:8444"),
        "ca_path": "/etc/hyperqwen-control/caddy-root.crt",
        "setup_url": "/api/client/setup.ps1",
        "ca_url": "/api/client/ca.crt",
    }))
    .into_response()
}

async fn host_engine_key() -> axum::response::Response {
    let mut body = fingerprint("/etc/hyperqwen-control/api_key");
    body["key"] = serde_json::json!(read_trim("/etc/hyperqwen-control/api_key"));
    axum::Json(body).into_response()
}


async fn host_gateway_requests() -> axum::response::Response {
    // Bounded tail, not the whole file: the access log grows forever and this
    // handler only shows the last 25 requests. It also runs off the async runtime.
    let text = tokio::task::spawn_blocking(|| {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open("/var/log/caddy/llm.log").ok()?;
        let length = file.metadata().ok()?.len();
        let start = length.saturating_sub(256 * 1024);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut text = String::new();
        file.read_to_string(&mut text).ok()?;
        Some(text)
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default();
    let mut requests: Vec<serde_json::Value> = Vec::new();
    for line in text.lines().rev() {
        let Some((_, payload)) = line.split_once("handled request\t") else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else { continue };
        let request = value.get("request").cloned().unwrap_or_default();
        requests.push(serde_json::json!({
            "time": line.split('\t').next(),
            "method": request.get("method"),
            "uri": request.get("uri"),
            "host": request.get("host"),
            "status": value.get("status"),
            "duration_ms": value.get("duration").and_then(|v| v.as_f64()).map(|v| (v * 1000.0).round()),
        }));
        if requests.len() >= 25 {
            break;
        }
    }
    axum::Json(serde_json::json!({ "requests": requests })).into_response()
}

async fn host_endpoints(headers: axum::http::HeaderMap) -> axum::response::Response {
    let host = public_host(&headers);
    let known: [(&str, &str, &str, &str); 10] = [
        ("Spark dashboard", "127.0.0.1", "3100", "loopback"),
        ("Plugin host", "127.0.0.1", "3199", "loopback"),
        ("Router", "127.0.0.1", "18030", "loopback"),
        ("Xinference", "127.0.0.1", "9997", "loopback"),
        ("Xinference worker", "127.0.0.1", "9998", "loopback"),
        ("Prometheus", "127.0.0.1", "9090", "loopback"),
        ("Grafana", "127.0.0.1", "3000", "loopback + tailnet"),
        ("Netdata", "127.0.0.1", "19999", "loopback + tailnet"),
        ("Caddy HTTPS (LLM)", "127.0.0.1", "8443", "LAN + tailnet"),
        ("Caddy HTTPS (UI)", "127.0.0.1", "8444", "LAN + tailnet"),
    ];
    let mut rows = Vec::new();
    for (name, bind_host, port, scope) in known {
        let addr = format!("{bind_host}:{port}");
        let ok = match addr.parse() {
            Ok(socket) => std::net::TcpStream::connect_timeout(
                &socket,
                std::time::Duration::from_millis(300),
            )
            .is_ok(),
            Err(_) => false,
        };
        let url = match port {
            "9997" => Some(format!("http://{host}:8445/ui")),
            "18030" => Some(format!("http://{host}:8446/router/status")),
            "9090" => Some(format!("http://{TAILNET}:9091")),
            "3000" => Some(format!("http://{TAILNET}:3000")),
            "19999" => Some(format!("http://{TAILNET}:19999")),
            "8443" => Some(format!("https://{TAILNET}:8443")),
            "8444" => Some(format!("https://{TAILNET}:8444")),
            "3100" => Some(format!("http://{host}:3100")),
            _ => None,
        };
        rows.push(serde_json::json!({ "name": name, "addr": addr, "scope": scope, "ok": ok, "url": url }));
    }
    axum::Json(serde_json::json!({ "endpoints": rows })).into_response()
}


// ── client downloads (proxied from the legacy control API while it runs) ────
async fn host_client_download(
    axum::extract::Path(name): axum::extract::Path<String>,
) -> axum::response::Response {
    // Served from disk. These used to be proxied to the legacy control API on 18080;
    // that API is retired, and the two files are all the client needs.
    let (path, content_type) = match name.as_str() {
        "setup.ps1" => ("/etc/hyperqwen-control/client-setup.ps1", "text/plain; charset=utf-8"),
        "ca.crt" => ("/etc/hyperqwen-control/caddy-root.crt", "application/x-x509-ca-cert"),
        _ => return (axum::http::StatusCode::NOT_FOUND, "unknown client file").into_response(),
    };
    match tokio::fs::read(path).await {
        Ok(bytes) => (
            [(axum::http::header::CONTENT_TYPE, content_type)],
            bytes,
        )
            .into_response(),
        Err(_) => (axum::http::StatusCode::NOT_FOUND, "client file missing").into_response(),
    }
}


// ── router request defaults (the router owns them since the gateway retired) ─
async fn host_router_defaults() -> axum::response::Response {
    match router_json("/router/defaults").await {
        Some(body) => axum::Json(body).into_response(),
        None => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "router unreachable").into_response(),
    }
}

async fn host_router_defaults_save(
    axum::Json(body): axum::Json<serde_json::Value>,
) -> axum::response::Response {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(client) => client,
        Err(_) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "http client").into_response(),
    };
    match client
        .put(format!("{ROUTER_BASE}/router/defaults"))
        .json(&body)
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            (
                axum::http::StatusCode::from_u16(status.as_u16()).unwrap_or(axum::http::StatusCode::BAD_GATEWAY),
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                text,
            )
                .into_response()
        }
        Err(_) => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "router unreachable").into_response(),
    }
}


/// Recent requests as the router recorded them: identity, outcome and token usage.
async fn host_router_requests() -> axum::response::Response {
    match router_json("/router/requests").await {
        Some(body) => axum::Json(body).into_response(),
        None => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "router unreachable").into_response(),
    }
}


// ── Netdata's own alarms (the alert engine, not its metrics) ────────────────
async fn host_netdata_alarms() -> axum::response::Response {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        Ok(client) => client,
        Err(_) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "http client").into_response(),
    };
    match client
        .get("http://127.0.0.1:19999/api/v1/alarms?active=1")
        .send()
        .await
    {
        Ok(response) => {
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            let mut alarms: Vec<serde_json::Value> = body
                .get("alarms")
                .and_then(|value| value.as_object())
                .map(|rows| {
                    rows.iter()
                        .map(|(key, value)| {
                            serde_json::json!({
                                "id": key,
                                "name": value.get("name"),
                                "chart": value.get("chart"),
                                "status": value.get("status"),
                                "summary": value.get("summary"),
                                "info": value.get("info"),
                                "when": value.get("last_status_change").or_else(|| value.get("when")),
                                "value": value.get("value"),
                                "units": value.get("units"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            alarms.sort_by_key(|alarm| match alarm["status"].as_str() {
                Some("CRITICAL") => 0,
                Some("WARNING") => 1,
                _ => 2,
            });
            axum::Json(serde_json::json!({ "alarms": alarms })).into_response()
        }
        Err(_) => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "netdata unreachable").into_response(),
    }
}


// ── legacy-parity surfaces: ownership, audit trail, journal tail ─────────────
async fn host_ownership() -> axum::response::Response {
    let models = match reqwest::get("http://127.0.0.1:9997/extensions/spark-bridge/models").await {
        Ok(response) => response.json::<serde_json::Value>().await.unwrap_or_default(),
        Err(_) => serde_json::Value::Null,
    };
    let by_gpu: std::collections::HashMap<String, serde_json::Value> = models
        .get("models")
        .and_then(|rows| rows.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let uuid = row.get("gpu_uuid")?.as_str()?.to_string();
                    Some((uuid, row.clone()))
                })
                .collect()
        })
        .unwrap_or_default();
    let output = tokio::task::spawn_blocking(|| {
        std::process::Command::new("nvidia-smi")
            .args([
                "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
                "--format=csv,noheader,nounits",
            ])
            .output()
            .ok()
    })
    .await
    .ok()
    .flatten();
    let mut rows = Vec::new();
    if let Some(output) = output {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let fields: Vec<&str> = line.split(',').map(str::trim).collect();
            if fields.len() < 4 {
                continue;
            }
            let model = by_gpu.get(fields[0]);
            rows.push(serde_json::json!({
                "gpu_uuid": fields[0],
                "pid": fields[1].parse::<u64>().ok(),
                "process": fields[2],
                "used_mib": fields[3].parse::<u64>().ok(),
                "model_uid": model.and_then(|value| value.get("uid")).cloned(),
                "model_name": model.and_then(|value| value.get("model_name")).cloned(),
                "gpu_index": model.and_then(|value| value.get("gpu_index")).cloned(),
            }));
        }
    }
    axum::Json(serde_json::json!({ "rows": rows })).into_response()
}

/// Last N lines of the control-plane audit trail (JSONL written by the router).
async fn host_audit() -> axum::response::Response {
    let lines = tokio::task::spawn_blocking(|| {
        let text = std::fs::read_to_string("/var/log/hyperqwen-control/audit.jsonl").ok()?;
        Some(
            text.lines()
                .rev()
                .take(100)
                .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap_or_else(|_| serde_json::json!({ "raw": line })))
                .collect::<Vec<_>>(),
        )
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default();
    axum::Json(serde_json::json!({ "entries": lines })).into_response()
}

/// Tail one whitelisted unit's journal.
async fn host_journal(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let unit = params.get("unit").map(String::as_str).unwrap_or("xinference");
    if !matches!(unit, "xinference" | "hyperqwen-router" | "spark-dashboard" | "caddy" | "smfc") {
        return (axum::http::StatusCode::BAD_REQUEST, "unit not allowed").into_response();
    }
    let unit = unit.to_string();
    let journal_unit = unit.clone();
    let lines = tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("journalctl")
            .args(["-u", &journal_unit, "-n", "80", "--no-pager", "-o", "short-iso"])
            .output()
            .ok()?;
        Some(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(|line| line.chars().take(240).collect::<String>())
                .collect::<Vec<_>>(),
        )
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default();
    axum::Json(serde_json::json!({ "unit": unit, "lines": lines })).into_response()
}
