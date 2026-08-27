//! wasmux wasmtime host: boots vmlinux.wasm under wasmtime and drives the
//! kernel-resident shell.
//!
//! The kernel imports the wasmux host ABI (console, clock, timer, random,
//! exit, shell input) from module "wasmux" and exports start_kernel plus
//! the shell input functions.  This host provides the imports, calls
//! start_kernel, and answers the kernel's blocking wasm_shell_wait()
//! import by reading lines from stdin (echo disabled, so the kernel's own
//! line echo shows).
//!
//! Usage: cargo run --release -- [path/to/vmlinux.wasm]

use std::io::{Read, Write};
use wasmtime::{Caller, Config, Engine, Linker, Module, Store};

struct Host {
    t0: std::time::Instant,
}

fn exit_kernel(code: i32) {
    std::process::exit(code);
}

/// Put stdin into raw mode (no echo, no canonical line buffering) so the
/// kernel's shell sees each keystroke and does its own echo + line
/// editing.  Returns the previous termios to restore on exit.
fn stdin_raw() -> Option<libc::termios> {
    use std::os::fd::AsRawFd;
    let fd = std::io::stdin().as_raw_fd();
    if unsafe { libc::isatty(fd) } != 1 {
        return None; // piped input: termios is irrelevant
    }
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut t) != 0 {
            return None;
        }
        let orig = t;
        t.c_lflag &= !(libc::ICANON | libc::ECHO);
        t.c_cc[libc::VMIN] = 1;
        t.c_cc[libc::VTIME] = 0;
        libc::tcsetattr(fd, libc::TCSANOW, &t);
        Some(orig)
    }
}

fn stdin_restore(orig: Option<libc::termios>) {
    if let Some(t) = orig {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::tcsetattr(std::io::stdin().as_raw_fd(), libc::TCSANOW, &t);
        }
    }
}

/// Read one raw byte from stdin (blocking); returns None on EOF.
fn read_raw_byte() -> Option<u8> {
    let mut byte = [0u8; 1];
    match std::io::stdin().read(&mut byte) {
        Ok(0) => None,
        Ok(_) => Some(byte[0]),
        Err(_) => None,
    }
}

fn main() -> wasmtime::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "vmlinux.wasm".into());
    let mut config = Config::new();
    // The kernel's shell blocks inside wasm_shell_wait() while waiting for
    // input, so no epoch-based hang detection is needed.
    let engine = Engine::new(&config)?;
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
            std::io::stdout().flush().ok();
        },
    )?;

    linker.func_wrap("wasmux", "wasm_time_ns", |caller: Caller<'_, Host>| -> i64 {
        caller.data().t0.elapsed().as_nanos() as i64
    })?;

    linker.func_wrap("wasmux", "wasm_time_ms", |caller: Caller<'_, Host>| -> i64 {
        caller.data().t0.elapsed().as_millis() as i64
    })?;

    linker.func_wrap("wasmux", "wasm_timer_arm", |_: Caller<'_, Host>, _ns: i64| {
        // One-shot timer; the cooperative kernel is driven by start_kernel
        // running to completion, so no host timer is needed yet.
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

    linker.func_wrap(
        "wasmux",
        "wasm_shell_wait",
        |mut caller: Caller<'_, Host>, ptr: i32, max_len: i32| -> i32 {
            let mem = caller
                .get_export("memory")
                .and_then(|e| e.into_memory())
                .expect("vmlinux.wasm must export memory");
            // One raw byte at a time: the kernel's shell echoes and does
            // the line editing, so the host only forwards keystrokes.
            match read_raw_byte() {
                Some(b) => {
                    if max_len >= 1 {
                        mem.write(&mut caller, ptr as usize, &[b]).ok();
                        1
                    } else {
                        0
                    }
                }
                None => -1, // EOF: the kernel treats this as exit
            }
        },
    )?;

    // raw mode for interactive sessions
    let orig_termios = stdin_raw();

    let instance = linker.instantiate(&mut store, &module)?;
    let start = instance.get_typed_func::<(), ()>(&mut store, "start_kernel")?;

    match start.call(&mut store, ()) {
        Ok(()) => println!("\n[wasmux] start_kernel returned (unexpected)"),
        Err(e) => {
            println!("\n[wasmux] kernel trapped: {e}");
            println!("[wasmux] error debug: {e:?}");
            stdin_restore(orig_termios);
        }
    }
    Ok(())
}
