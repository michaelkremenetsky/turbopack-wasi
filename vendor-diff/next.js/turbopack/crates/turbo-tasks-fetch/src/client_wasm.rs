use anyhow::Result;
use turbo_rcstr::RcStr;
use turbo_tasks::{ResolvedVc, Vc, mark_session_dependent};
use turbopack_core::issue::StyledString;

use crate::{FetchError, FetchErrorKind, FetchResult};

/// WASM stub for `FetchClientConfig`. reqwest does not build on wasm targets, so `fetch` always
/// resolves to a `FetchResult` error, which surfaces as an issue rather than a build failure.
#[turbo_tasks::value(shared)]
#[derive(Hash, Default)]
pub struct FetchClientConfig {}

#[turbo_tasks::value_impl]
impl FetchClientConfig {
    #[turbo_tasks::function(network)]
    pub async fn fetch(
        self: Vc<FetchClientConfig>,
        url: RcStr,
        _user_agent: Option<RcStr>,
    ) -> Result<Vc<FetchResult>> {
        mark_session_dependent();
        Ok(Vc::cell(Err(FetchError {
            detail: StyledString::Text("HTTP fetching is not supported on WASM targets".into())
                .resolved_cell(),
            url: ResolvedVc::cell(url),
            kind: FetchErrorKind::Other.resolved_cell(),
        }
        .resolved_cell())))
    }
}

#[doc(hidden)]
pub fn __test_only_reqwest_client_cache_clear() {}

#[doc(hidden)]
pub fn __test_only_reqwest_client_cache_len() -> usize {
    0
}
