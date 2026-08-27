//! wasmux wasmer host — boots vmlinux.wasm under wasmer.
//!
//! The kernel imports the wasmux host ABI (console, clock, timer, random,
//! exit) from module "wasmux" and exports start_kernel.  This host
//! provides those imports and calls start_kernel, printing the kernel
//! console to stdout.
//!
//! Usage: cargo run --release -- [path/to/vmlinux.wasm]

use std::cell::RefCell;
use std::io::{Read, Write};
use std::rc::Rc;
use wasmer::{imports, Engine, Function, Instance, Module, Store, TypedFunction};

struct Env {
    memory: RefCell<Option<wasmer::Memory>>,
    t0: std::time::Instant,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "vmlinux.wasm".into());
    let engine = Engine::default();
    let module = Module::from_file(&engine, &path)?;
    let env = Rc::new(Env {
        memory: RefCell::new(None),
        t0: std::time::Instant::now(),
    });

    let mut store = Store::new(&engine, ());

    let env_console = env.clone();
    let console_write = Function::new_with_env(
        &mut store,
        &env_console,
        |env: &Env, ptr: i32, len: i32| {
            let mem = env.memory.borrow();
            let mem = mem.as_ref().expect("memory not set yet");
            let view = mem.view::<u8>();
            let start = ptr as usize;
            let end = (start + len as usize).min(view.len());
            let mut out = Vec::with_capacity(end - start);
            for i in start..end {
                out.push(view[i].get());
            }
            std::io::stdout().write_all(&out).ok();
        },
    );

    let env_time = env.clone();
    let time_ns = Function::new_with_env(&mut store, &env_time, |env: &Env| -> i64 {
        env.t0.elapsed().as_nanos() as i64
    });

    let timer_arm = Function::new_with_env(&mut store, &env, |_env: &Env, _ns: i64| {
        // one-shot timer; the cooperative kernel runs to completion
    });

    let env_random = env.clone();
    let random = Function::new_with_env(
        &mut store,
        &env_random,
        |env: &Env, ptr: i32, len: i32| -> i32 {
            let mut buf = vec![0u8; len as usize];
            if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
                f.read_exact(&mut buf).ok();
            }
            let mem = env.memory.borrow();
            if let Some(mem) = mem.as_ref() {
                let view = mem.view::<u8>();
                for i in 0..buf.len() {
                    let off = ptr as usize + i;
                    if off < view.len() {
                        view[off].set(buf[i]);
                    }
                }
            }
            len
        },
    );

    let env_exit = env.clone();
    let exit = Function::new_with_env(&mut store, &env_exit, |_env: &Env, code: i32| {
        std::process::exit(code);
    });

    let import_object = imports! {
        "wasmux" => {
            "wasm_console_write" => console_write,
            "wasm_time_ns" => time_ns,
            "wasm_timer_arm" => timer_arm,
            "wasm_random" => random,
            "wasm_exit" => exit,
        },
    };

    let instance = Instance::new(&mut store, &module, &import_object)?;
    *env.memory.borrow_mut() = Some(instance.exports.get_memory("memory")?.clone());

    let start: TypedFunction<(), ()> = instance.exports.get_typed_function(&store, "start_kernel")?;
    match start.call(&mut store) {
        Ok(()) => println!("\n[wasmux] start_kernel returned (unexpected)"),
        Err(e) => println!("\n[wasmux] kernel trapped: {e}"),
    }
    Ok(())
}
