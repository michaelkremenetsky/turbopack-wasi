/*
Copyright (c) 2017 The swc Project Developers

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
*/

#![recursion_limit = "2048"]
//#![deny(clippy::all)]
#![feature(arbitrary_self_types)]
#![feature(arbitrary_self_types_pointers)]
#![feature(iter_intersperse)]

use std::sync::Arc;

use napi::bindgen_prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use swc_core::{
    atoms::Atom,
    base::{Compiler, TransformOutput},
    common::{FilePathMapping, SourceMap},
};

pub mod code_frame;
#[cfg(not(target_arch = "wasm32"))]
pub mod css;
pub mod lockfile;
pub mod mdx;
pub mod minify;
pub mod next_api;
pub mod parse;
pub mod react_compiler;
pub mod rspack;
pub mod transform;
#[cfg(not(target_arch = "wasm32"))]
pub mod turbo_trace_server;
pub mod turbopack;
pub mod util;

#[cfg(not(any(feature = "__internal_dhat-heap", feature = "__internal_dhat-ad-hoc")))]
#[global_allocator]
static ALLOC: turbo_tasks_malloc::TurboMalloc = turbo_tasks_malloc::TurboMalloc;

#[cfg(feature = "__internal_dhat-heap")]
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

#[cfg(target_arch = "wasm32")]
static WASI_RUNTIME_INSTALLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// On wasm, napi's fallback is a current-thread tokio runtime that only advances while a napi
/// call is blocked on it, which stalls turbo-tasks' background work. Wasm hosts MUST call this
/// raw wasm export (`instance.exports.init_turbopack_wasi_runtime_raw(threads)`) right after
/// instantiation and BEFORE ANY napi call: napi wraps every call in
/// `within_runtime_if_available`, which force-initializes the fallback runtime, after which a
/// custom runtime can no longer be installed.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn init_turbopack_wasi_runtime_raw(worker_threads: u32) -> i32 {
    use tokio::runtime::Builder;
    use turbo_tasks_malloc::TurboMalloc;

    let threads = (worker_threads.max(1)) as usize;
    let rt = match Builder::new_multi_thread()
        .worker_threads(threads)
        // std::thread::available_parallelism is unsupported on wasi; every implicit sizing
        // must be explicit here.
        .max_blocking_threads(threads * 4)
        // wasi thread stacks live in linear memory at exactly the requested size, and wasm
        // shadow-stack frames are several times larger than native (everything spills to the
        // stack; turbo-tasks functions inline large futures). The 2MB std/tokio default
        // overflows nondeterministically under compile load (OOB traps at task-function
        // entry), so give worker + blocking threads real headroom.
        .thread_stack_size(16 * 1024 * 1024)
        // Time only, deliberately no io driver: mio's wasi poll returns immediately instead of
        // blocking, which turns the tokio driver park into a 100%-CPU spin. Without the io
        // driver the runtime parks on a condvar (wasm atomics), which blocks properly. Network
        // and fs work goes through the host (napi/emnapi) rather than tokio's io driver anyway.
        .enable_time()
        .on_thread_stop(|| {
            TurboMalloc::thread_stop();
        })
        .build()
    {
        Ok(rt) => rt,
        Err(_) => return -1,
    };
    napi::bindgen_prelude::create_custom_tokio_runtime(rt);
    WASI_RUNTIME_INSTALLED.store(true, std::sync::atomic::Ordering::SeqCst);
    0
}

/// Verifies the wasm host installed the multi-threaded runtime (see
/// `init_turbopack_wasi_runtime_raw`). Kept as a napi export so JS can assert the setup early
/// with a clear error instead of deadlocking later.
#[cfg(target_arch = "wasm32")]
#[napi_derive::napi]
pub fn init_turbopack_wasi_runtime(_worker_threads: Option<u32>) -> napi::Result<()> {
    if !WASI_RUNTIME_INSTALLED.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(napi::Error::from_reason(
            "multi-threaded tokio runtime not installed: call the raw wasm export \
             instance.exports.init_turbopack_wasi_runtime_raw(threads) BEFORE any napi call \
             (napi calls force-initialize a single-threaded fallback runtime)",
        ));
    }
    Ok(())
}

/// Probe: resolves after `ms` via tokio::time::sleep on the installed runtime. If this never
/// resolves, the tokio time driver is not working on this host.
#[cfg(target_arch = "wasm32")]
#[napi_derive::napi]
pub async fn debug_sleep(ms: u32) -> napi::Result<u32> {
    tokio::time::sleep(std::time::Duration::from_millis(ms as u64)).await;
    Ok(ms)
}

/// Probe: reads a file through tokio's blocking pool (the same path turbo-tasks-fs uses).
#[cfg(target_arch = "wasm32")]
#[napi_derive::napi]
pub async fn debug_read_file(path: String) -> napi::Result<u32> {
    let len = tokio::task::spawn_blocking(move || std::fs::read(&path).map(|v| v.len()))
        .await
        .map_err(|e| napi::Error::from_reason(format!("join error: {e}")))?
        .map_err(|e| napi::Error::from_reason(format!("read error: {e}")))?;
    Ok(len as u32)
}

/// Probe: runs a task through tokio::spawn (worker) and returns.
#[cfg(target_arch = "wasm32")]
#[napi_derive::napi]
pub async fn debug_spawn(value: u32) -> napi::Result<u32> {
    tokio::spawn(async move { value * 2 })
        .await
        .map_err(|e| napi::Error::from_reason(format!("join error: {e}")))
}

/// Probe: create a ThreadsafeFunction from `cb` and call it 3 times from a spawned thread.
#[cfg(target_arch = "wasm32")]
#[napi_derive::napi]
pub fn debug_tsfn_echo(
    #[napi(ts_arg_type = "(err: Error | null, value: number) => void")] cb: napi::JsFunction,
) -> napi::Result<()> {
    use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunctionCallMode};
    let tsfn: napi::threadsafe_function::ThreadsafeFunction<u32, ErrorStrategy::CalleeHandled> =
        cb.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;
    std::thread::spawn(move || {
        for i in 0..3u32 {
            tsfn.call(Ok(i), ThreadsafeFunctionCallMode::Blocking);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });
    Ok(())
}

/// Probe: install a plain-text tracing subscriber writing to stderr, with the given env-filter
/// (e.g. "turbo_tasks=info,next_api=debug").
#[cfg(target_arch = "wasm32")]
#[napi_derive::napi]
pub fn debug_enable_tracing(filter: String) -> napi::Result<()> {
    use tracing_subscriber::{EnvFilter, fmt, prelude::*};
    tracing_subscriber::registry()
        .with(
            fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(false)
                .with_span_events(fmt::format::FmtSpan::NEW),
        )
        .with(EnvFilter::try_new(filter).map_err(|e| napi::Error::from_reason(e.to_string()))?)
        .try_init()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
#[napi::module_init]
fn init() {
    use std::{
        cell::RefCell,
        panic::{set_hook, take_hook},
        thread::available_parallelism,
        time::{Duration, Instant},
    };

    thread_local! {
        static LAST_SWC_ATOM_GC_TIME: RefCell<Option<Instant>> = const { RefCell::new(None) };
    }

    use tokio::runtime::Builder;
    use turbo_tasks::panic_hooks::handle_panic;
    use turbo_tasks_malloc::TurboMalloc;

    let prev_hook = take_hook();
    set_hook(Box::new(move |info| {
        handle_panic(info);
        prev_hook(info);
    }));

    let worker_threads = available_parallelism().map(|n| n.get()).unwrap_or(1);

    let rt = Builder::new_multi_thread()
        .enable_all()
        .on_thread_stop(|| {
            TurboMalloc::thread_stop();
        })
        .on_thread_park(|| {
            LAST_SWC_ATOM_GC_TIME.with_borrow_mut(|cell| {
                if cell.is_none_or(|t| t.elapsed() > Duration::from_secs(2)) {
                    swc_core::ecma::atoms::hstr::global_atom_store_gc();
                    *cell = Some(Instant::now());
                }
            });
        })
        .worker_threads(worker_threads)
        // Avoid a limit on threads to avoid deadlocks due to usage of block_in_place
        .max_blocking_threads(usize::MAX - worker_threads)
        // Avoid the extra lifo slot to avoid stalling tasks when doing cpu-heavy work
        .disable_lifo_slot()
        .build()
        .unwrap();
    create_custom_tokio_runtime(rt);
}

#[inline]
fn get_compiler() -> Compiler {
    let cm = Arc::new(SourceMap::new(FilePathMapping::empty()));

    Compiler::new(cm)
}

pub fn complete_output(
    env: &Env,
    output: TransformOutput,
    eliminated_packages: FxHashSet<Atom>,
    use_cache_telemetry_tracker: FxHashMap<String, usize>,
) -> napi::Result<Object> {
    let mut js_output = env.create_object()?;
    js_output.set_named_property("code", env.create_string_from_std(output.code)?)?;
    if let Some(map) = output.map {
        js_output.set_named_property("map", env.create_string_from_std(map)?)?;
    }
    if !eliminated_packages.is_empty() {
        js_output.set_named_property(
            "eliminatedPackages",
            env.create_string_from_std(serde_json::to_string(&eliminated_packages)?)?,
        )?;
    }
    if !use_cache_telemetry_tracker.is_empty() {
        js_output.set_named_property(
            "useCacheTelemetryTracker",
            env.create_string_from_std(serde_json::to_string(
                &use_cache_telemetry_tracker
                    .iter()
                    .map(|(k, v)| (k.clone(), *v))
                    .collect::<Vec<_>>(),
            )?)?,
        )?;
    }

    Ok(js_output)
}
