//! wasmux wasmer host: boots vmlinux.wasm under wasmer.
//!
//! The kernel imports the wasmux host ABI (console, clock, timer, random,
//! exit) from module "wasmux" and exports start_kernel.  This host
//! provides those imports and calls start_kernel, printing the kernel
//! console to stdout.
//!
//! Usage: cargo run --release -- [path/to/vmlinux.wasm]

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use wasmer::{
    AsStoreMut, Function, FunctionEnv, FunctionEnvMut, FunctionType, Instance, Memory, Module,
    Store, Type, TypedFunction, Value,
};

#[derive(Clone)]
struct Env {
    memory: Arc<Mutex<Option<Memory>>>,
    t0: Arc<std::time::Instant>,
}

impl Default for Env {
    fn default() -> Self {
        Env {
            memory: Arc::new(Mutex::new(None)),
            t0: Arc::new(std::time::Instant::now()),
        }
    }
}

fn exit_kernel(code: i32) {
    std::process::exit(code);
}

fn i32pair() -> FunctionType {
    FunctionType::new(vec![Type::I32, Type::I32], vec![])
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "vmlinux.wasm".into());
    let engine = wasmer::Engine::default();
    let module = Module::from_file(&engine, &path)?;

    let mut store = Store::new(engine);
    let env = FunctionEnv::new(&mut store, Env::default());

    let console_write = Function::new_with_env(
        &mut store,
        &env,
        i32pair(),
        |mut env: FunctionEnvMut<Env>, args: &[Value]| -> Result<Vec<Value>, wasmer::RuntimeError> {
            let ptr = args[0].i32().unwrap_or(0) as u64;
            let len = args[1].i32().unwrap_or(0) as u64;
            let mut buf = vec![0u8; len as usize];
            if let Some(mem) = env.data().memory.lock().unwrap().as_ref() {
                if mem.view(&env).read(ptr, &mut buf).is_ok() {
                    std::io::stdout().write_all(&buf).ok();
                }
            }
            Ok(vec![])
        },
    );

    let time_ns = Function::new_with_env(
        &mut store,
        &env,
        FunctionType::new(vec![], vec![Type::I64]),
        |env: FunctionEnvMut<Env>, _args: &[Value]| -> Result<Vec<Value>, wasmer::RuntimeError> {
            Ok(vec![Value::I64(env.data().t0.elapsed().as_nanos() as i64)])
        },
    );

    let timer_arm = Function::new_with_env(
        &mut store,
        &env,
        FunctionType::new(vec![Type::I64], vec![]),
        |_env: FunctionEnvMut<Env>, _args: &[Value]| -> Result<Vec<Value>, wasmer::RuntimeError> {
            // one-shot timer; the cooperative kernel runs to completion
            Ok(vec![])
        },
    );

    let random = Function::new_with_env(
        &mut store,
        &env,
        FunctionType::new(vec![Type::I32, Type::I32], vec![Type::I32]),
        |mut env: FunctionEnvMut<Env>, args: &[Value]| -> Result<Vec<Value>, wasmer::RuntimeError> {
            let ptr = args[0].i32().unwrap_or(0) as u64;
            let len = args[1].i32().unwrap_or(0) as usize;
            let mut buf = vec![0u8; len];
            if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
                f.read_exact(&mut buf).ok();
            }
            if let Some(mem) = env.data().memory.lock().unwrap().as_ref() {
                mem.view(&env).write(ptr, &buf).ok();
            }
            Ok(vec![Value::I32(len as i32)])
        },
    );

    let exit = Function::new_with_env(
        &mut store,
        &env,
        FunctionType::new(vec![Type::I32], vec![]),
        |_env: FunctionEnvMut<Env>, args: &[Value]| -> Result<Vec<Value>, wasmer::RuntimeError> {
            exit_kernel(args[0].i32().unwrap_or(0));
            Ok(vec![])
        },
    );

    let import_object = wasmer::imports! {
        "wasmux" => {
            "wasm_console_write" => console_write,
            "wasm_time_ns" => time_ns,
            "wasm_timer_arm" => timer_arm,
            "wasm_random" => random,
            "wasm_exit" => exit,
        },
    };

    let instance = Instance::new(&mut store, &module, &import_object)?;
    let memory = instance.exports.get_memory("memory")?.clone();
    env.as_mut(&mut store).memory.lock().unwrap().replace(memory);

    let start: TypedFunction<(), ()> =
        instance.exports.get_typed_function::<(), ()>(&store, "start_kernel")?;
    match start.call_sys(&mut store) {
        Ok(()) => println!("\n[wasmux] start_kernel returned (unexpected)"),
        Err(e) => println!("\n[wasmux] kernel trapped: {e}"),
    }
    Ok(())
}
