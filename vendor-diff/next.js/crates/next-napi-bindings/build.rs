use std::{env, fs, path::Path, process::Command, str};

use serde_json::Value;

fn main() -> anyhow::Result<()> {
    println!("cargo:rerun-if-env-changed=CI");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_OS");
    let is_ci = env::var("CI").is_ok_and(|value| !value.is_empty());
    let is_macos_target = env::var("CARGO_CFG_TARGET_OS").is_ok_and(|value| value == "macos");

    let nextjs_version = {
        let package_json_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("packages/next/package.json");

        println!("cargo:rerun-if-changed={}", package_json_path.display());

        let package_json_content = fs::read_to_string(&package_json_path)?;
        let package_json: Value = serde_json::from_str(&package_json_content)?;

        package_json["version"]
            .as_str()
            .expect("Expected a Next.js `version` string in its package.json")
            .to_string()
    };

    // Make the Next.js version available as a build-time environment variable
    println!("cargo:rustc-env=NEXTJS_VERSION={nextjs_version}");

    // Generates, stores build-time information as static values.
    // There are some places relying on correct values for this (i.e telemetry),
    // So failing build if this fails.
    let cargo = vergen_gitcl::CargoBuilder::default()
        .target_triple(true)
        .build()?;
    // We use the git dirty state to disable filesystem cache (filesystem cache relies on a
    // commit hash to be safe). One tradeoff of this is that we must invalidate the rust build more
    // often.
    //
    // This invalidates the build if any untracked files change. That's sufficient for the case
    // where we transition from dirty to clean.
    //
    // There's an edge-case here where the repository could be newly dirty, but we can't know
    // because our build hasn't been invalidated, since the untracked files weren't untracked last
    // time we ran. That will cause us to incorrectly report ourselves as clean.
    //
    // However, in practice that shouldn't be much of an issue: If no other dependency of this
    // top-level crate has changed (which would've triggered our rebuild), then the resulting binary
    // must be equivalent to a clean build anyways. Therefore, filesystem cache using the HEAD
    // commit hash as a version is okay.
    let git = vergen_gitcl::GitclBuilder::default()
        .dirty(/* include_untracked */ true)
        .describe(
            /* tags */ true,
            /* dirty */ !is_ci, // suppress the dirty suffix in CI
            /* matches */ Some("v[0-9]*"), // find the last version tag
        )
        .build()?;
    vergen_gitcl::Emitter::default()
        .fail_on_error()
        .add_instructions(&cargo)?
        .add_instructions(&git)?
        .emit()?;

    match Command::new("git").args(["rev-parse", "HEAD"]).output() {
        Ok(out) if out.status.success() => println!(
            "cargo:warning=git HEAD: {}",
            str::from_utf8(&out.stdout).unwrap()
        ),
        Ok(out) => println!(
            "cargo:warning=`git rev-parse HEAD` failed with status {}: {}",
            out.status,
            str::from_utf8(&out.stderr).unwrap()
        ),
        Err(e) => println!("cargo:warning=`git rev-parse HEAD` could not be spawned: {e}"),
    }

    if !is_macos_target {
    if env::var("CARGO_CFG_TARGET_OS").is_ok_and(|value| value == "wasi") {
        // Mirrors napi_build::setup()'s wasi branch, except `--export-dynamic`: that flag
        // exports every dynamic symbol, and this workspace produces >100k of them, exceeding
        // V8's 100,000-export limit for wasm modules. Every `#[napi]` register function
        // carries `#[export_name]` and is exported explicitly by rustc regardless.
        let link_dir = env::var("EMNAPI_LINK_DIR").expect("EMNAPI_LINK_DIR must be set");
        println!("cargo:rerun-if-env-changed=EMNAPI_LINK_DIR");
        println!("cargo:rerun-if-env-changed=WASI_REGISTER_TMP_PATH");
        println!("cargo:rustc-link-search={link_dir}");
        println!("cargo:rustc-link-lib=static=emnapi-basic-mt");
        println!("cargo:rustc-link-arg=--export=malloc");
        println!("cargo:rustc-link-arg=--export=free");
        println!("cargo:rustc-link-arg=--export=napi_register_wasm_v1");
        println!("cargo:rustc-link-arg=--export-if-defined=node_api_module_get_api_version_v1");
        println!("cargo:rustc-link-arg=--export-table");
        println!("cargo:rustc-link-arg=--export=emnapi_async_worker_create");
        println!("cargo:rustc-link-arg=--export=emnapi_async_worker_init");
        println!("cargo:rustc-link-arg=--export-if-defined=wasi_thread_start");
        println!("cargo:rustc-link-arg=--import-memory");
        println!("cargo:rustc-link-arg=--import-undefined");
        println!("cargo:rustc-link-arg=--max-memory=4294967296");
        println!("cargo:rustc-link-arg=-zstack-size=6400000");
        println!("cargo:rustc-link-arg=--no-check-features");
        // The wasi reactor crt provides _initialize: main thread-pointer setup + C ctors.
        // rustc links no crt for cdylibs, and without TP setup napi registration spins
        // inside pthread_key handling. node:wasi's initialize() calls the export.
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let sysroot_out = Command::new(&rustc)
            .args(["--print", "sysroot"])
            .output()
            .expect("failed to run rustc --print sysroot");
        let sysroot = str::from_utf8(&sysroot_out.stdout)
            .expect("sysroot is not utf-8")
            .trim()
            .to_string();
        let target = env::var("TARGET").expect("TARGET is not set");
        println!(
            "cargo:rustc-link-arg={sysroot}/lib/rustlib/{target}/lib/self-contained/crt1-reactor.o"
        );
        println!("cargo:rustc-link-arg=--export=_initialize");
    } else {
        napi_build::setup();
    }
    }

    // This is a workaround for napi always including a GCC-specific flag on macOS.
    if is_macos_target {
        println!("cargo:rerun-if-env-changed=DEBUG_GENERATED_CODE");
        println!("cargo:rerun-if-env-changed=TYPE_DEF_TMP_PATH");
        println!("cargo:rerun-if-env-changed=CARGO_CFG_NAPI_RS_CLI_VERSION");

        println!("cargo:rustc-cdylib-link-arg=-undefined");
        println!("cargo:rustc-cdylib-link-arg=dynamic_lookup");
    }

    // Resolve a potential linker issue for unit tests on linux
    // https://github.com/napi-rs/napi-rs/issues/1782
    #[cfg(all(target_os = "linux", not(target_arch = "wasm32")))]
    println!("cargo:rustc-link-arg=-Wl,--warn-unresolved-symbols");

    Ok(())
}
