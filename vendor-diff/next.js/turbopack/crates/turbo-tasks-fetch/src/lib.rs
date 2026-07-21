#![feature(min_specialization)]
#![feature(arbitrary_self_types)]
#![feature(arbitrary_self_types_pointers)]

#[cfg(not(target_family = "wasm"))]
mod client;
// reqwest does not build on wasm targets; use a stub client whose fetches resolve to errors.
#[cfg(target_family = "wasm")]
#[path = "client_wasm.rs"]
mod client;
mod error;
mod response;

pub use crate::{
    client::{
        __test_only_reqwest_client_cache_clear, __test_only_reqwest_client_cache_len,
        FetchClientConfig,
    },
    error::{FetchError, FetchErrorKind, FetchIssue},
    response::{FetchResult, HttpResponse, HttpResponseBody},
};
