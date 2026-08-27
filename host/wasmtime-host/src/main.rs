//! wasmux wasmtime host: boots vmlinux.wasm under wasmtime.
//!
//! The kernel imports the wasmux host ABI (console, clock, timer, random,
//! exit) from module "wasmux" and exports start_kernel.  This host
//! provides those imports and calls start_kernel, printing the kernel
//! console to stdout.
//!
//! Usage: cargo run --release -- [path/to/vmlinux.wasm]

use std::io::Write;
use wasmtime::{Caller, Engine, Linker, Module, Store};

struct Host {
    t0: std::time::Instant,
}

fn exit_kernel(code: i32) {
    std::process::exit(code);
}

fn main() -> wasmtime::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "vmlinux.wasm".into());
    let engine = Engine::default();
    let module = Module::from_file(&engine, &path)?;

    let mut store = Store::new(&engine, Host {
        t0: std::time::Instant::now(),
    });

    let mut linker = Linker::new(&engine);

    linker.func_wrap(
        "wasmux",
        "wasm_console_write",
        |mut caller: Caller<'_, Host>, ptr: i32, len: i32| {
            let mem = caller
                .get_export("memory")
                .and_then(|e| e.into_memory())
                .expect("vmlinux.wasm must export memory");
            let data = mem.data(&caller);
            let start = ptr as usize;
            let end = start + len as usize;
            std::io::stdout().write_all(&data[start.min(data.len())..end.min(data.len())]).ok();
        },
    )?;

    linker.func_wrap("wasmux", "wasm_time_ns", |caller: Caller<'_, Host>| -> i64 {
        caller.data().t0.elapsed().as_nanos() as i64
    })?;

    linker.func_wrap("wasmux", "wasm_timer_arm", |_: Caller<'_, Host>, _ns: i64| {
        // one-shot timer; the cooperative kernel is driven by start_kernel
        // running to completion, so no host timer is needed yet
    })?;

    linker.func_wrap(
        "wasmux",
        "wasm_random",
        |mut caller: Caller<'_, Host>, ptr: i32, len: i32| -> i32 {
            let mem = caller
                .get_export("memory")
                .and_then(|e| e.into_memory())
                .expect("vmlinux.wasm must export memory");
            let mut buf = vec![0u8; len as usize];
            let mut f = std::fs::File::open("/dev/urandom").expect("open /dev/urandom");
            use std::io::Read;
            f.read_exact(&mut buf).ok();
            mem.write(&mut caller, ptr as usize, &buf).ok();
            len
        },
    )?;

    linker.func_wrap("wasmux", "wasm_exit", |_: Caller<'_, Host>, code: i32| {
        exit_kernel(code);
    })?;

    let instance = linker.instantiate(&mut store, &module)?;
    let start = instance.get_typed_func::<(), ()>(&mut store, "start_kernel")?;

    match start.call(&mut store, ()) {
        Ok(()) => println!("\n[wasmux] start_kernel returned (unexpected)"),
        Err(e) => {
            println!("\n[wasmux] kernel trapped: {e}");
            println!("[wasmux] error debug: {e:?}");
            if let Some(trap) = e.downcast_ref::<wasmtime::Trap>() {
                println!("[wasmux] trap code: {:?}", trap.trap_code());
            }
        }
    }
    Ok(())
}
