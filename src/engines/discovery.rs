//! External engine discovery — a generic provider for engines Spark cannot find
//! by scanning processes.
//!
//! Spark's collector detects engines by walking `/proc` and the Docker API,
//! which works when the inference process is on this host and owns a PID. A
//! model managed by another process (Xinference runs vLLM in its own worker and
//! exposes a per-model endpoint) has neither, so a process scan can never see
//! it.
//!
//! This module adds the missing half: a URL that answers with a JSON document
//! listing engines. It is deliberately ignorant of who answers — the document
//! is a plain list of endpoints — so a plugin can provide it without Spark
//! learning anything about that plugin.
//!
//! ```json
//! {"authoritative": true,
//!  "engines": [{"type": "vllm", "endpoint": "http://127.0.0.1:9997/x/models/a",
//!               "served_model": "a", "gpu_index": 1}]}
//! ```
//!
//! `authoritative` defaults to true: a successful fetch of an authoritative
//! document is the whole truth, so an engine missing from it is retired. A
//! failed fetch or `authoritative: false` retires nothing, because a provider
//! outage is not evidence that a model went away.

use std::collections::HashSet;
use std::time::Duration;

use serde::Deserialize;

use super::EngineType;

/// One engine the provider says exists.
#[derive(Clone, Debug, Deserialize)]
pub struct DiscoveredEngine {
    /// Wire name of the engine type: `vllm`, `sglang` or `ollama`.
    #[serde(rename = "type", default = "default_type")]
    pub engine_type: String,
    /// Base URL Spark should poll, e.g. a per-model bridge endpoint.
    pub endpoint: String,
    /// Model identity to fall back on when `/v1/models` is slow or vague.
    #[serde(default)]
    pub served_model: Option<String>,
    /// Host NVML index, when the provider knows it authoritatively. Used only
    /// if the PID-based match finds nothing.
    #[serde(default)]
    pub gpu_index: Option<u32>,
}

fn default_type() -> String {
    "vllm".to_string()
}

/// The provider's answer.
#[derive(Clone, Debug, Deserialize)]
pub struct DiscoveryDocument {
    /// Whether this list is the complete truth. Defaults to true.
    #[serde(default = "default_authoritative")]
    pub authoritative: bool,
    #[serde(default)]
    pub engines: Vec<DiscoveredEngine>,
}

fn default_authoritative() -> bool {
    true
}

/// Maps the document's type name onto Spark's engine vocabulary. An unknown
/// name is skipped rather than guessed: polling an endpoint with the wrong
/// adapter produces confident nonsense.
pub fn parse_engine_type(name: &str) -> Option<EngineType> {
    match name.trim().to_ascii_lowercase().as_str() {
        "vllm" | "vllm-openai" => Some(EngineType::Vllm),
        "sglang" => Some(EngineType::Sglang),
        "ollama" => Some(EngineType::Ollama),
        _ => None,
    }
}

/// Fetches the document. The error string is for a debug log line only.
pub async fn fetch(client: &reqwest::Client, url: &str) -> Result<DiscoveryDocument, String> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("provider answered {}", response.status()));
    }
    response
        .json::<DiscoveryDocument>()
        .await
        .map_err(|error| format!("invalid document: {error}"))
}

/// Which previously known endpoints this document retires.
///
/// Empty when the document is not authoritative: a partial answer is not a
/// deletion notice. Pure so the rule can be tested without a network.
pub fn retired(known: &HashSet<String>, document: &DiscoveryDocument) -> Vec<String> {
    if !document.authoritative {
        return Vec::new();
    }
    let present: HashSet<&str> = document.engines.iter().map(|e| e.endpoint.as_str()).collect();
    known
        .iter()
        .filter(|endpoint| !present.contains(endpoint.as_str()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(json: &str) -> DiscoveryDocument {
        serde_json::from_str(json).expect("document parses")
    }

    #[test]
    fn an_empty_document_is_authoritative_by_default() {
        let parsed = doc(r#"{"engines": []}"#);
        assert!(parsed.authoritative);
        assert!(parsed.engines.is_empty());
    }

    #[test]
    fn engines_default_to_vllm_and_carry_optional_identity() {
        let parsed = doc(
            r#"{"engines": [
                {"endpoint": "http://a:1/x"},
                {"type": "sglang", "endpoint": "http://b:2", "served_model": "m", "gpu_index": 3}
            ]}"#,
        );
        assert_eq!(parsed.engines[0].engine_type, "vllm");
        assert_eq!(parsed.engines[0].served_model, None);
        assert_eq!(parsed.engines[1].gpu_index, Some(3));
    }

    #[test]
    fn unknown_type_names_are_skipped_rather_than_guessed() {
        assert!(parse_engine_type("vllm").is_some());
        assert!(parse_engine_type("VLLM").is_some());
        assert!(parse_engine_type("vllm-openai").is_some());
        assert!(parse_engine_type("lmstudio").is_none());
    }

    #[test]
    fn authoritative_documents_retire_missing_endpoints() {
        let known: HashSet<String> = ["http://a", "http://b"].iter().map(|s| s.to_string()).collect();
        let parsed = doc(r#"{"engines": [{"endpoint": "http://a"}]}"#);
        assert_eq!(retired(&known, &parsed), vec!["http://b".to_string()]);
    }

    #[test]
    fn non_authoritative_documents_retire_nothing() {
        let known: HashSet<String> = ["http://a"].iter().map(|s| s.to_string()).collect();
        let parsed = doc(r#"{"authoritative": false, "engines": []}"#);
        assert!(retired(&known, &parsed).is_empty());
    }

    #[test]
    fn an_empty_authoritative_document_retires_everything() {
        let known: HashSet<String> = ["http://a", "http://b"].iter().map(|s| s.to_string()).collect();
        let parsed = doc(r#"{"engines": []}"#);
        assert_eq!(retired(&known, &parsed).len(), 2);
    }
}
