// 守岸人 · Tauri 桌面外壳
//
// 启动流程：
//   1) 挑一个空闲端口；
//   2) 拉起 Node 后端 sidecar（打包后的 守岸人.exe，自带 public/ 与依赖）；
//   3) 窗口先显示内置闪屏，轮询后端 /api/health 就绪；
//   4) 就绪后把窗口切到本地服务地址（真正的应用界面）；
//   5) 应用退出时结束 sidecar，避免残留进程。

use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 后端 sidecar 句柄：应用退出时负责结束进程
struct Backend(Mutex<Option<CommandChild>>);

/// 挑选后端监听的端口：优先使用固定端口，保证每次启动的页面 origin 一致。
///
/// 为什么要固定端口：前端把对话记录存在浏览器 localStorage 里，而 localStorage
/// 是按 origin（协议 + 主机 + 端口）隔离的。如果端口每次都随机，等于每次打开的都是
/// 一个全新的「网站」，旧的对话记录会被判给上一个 origin 而读不到，用户就会觉得
/// 应用「每次都像第一次见我」。所以这里从 34117 起依次尝试固定端口，全部被占用时
/// 才回退到系统随机分配（仅在极端情况下才会发生）。
fn pick_port() -> u16 {
    const BASE_PORT: u16 = 34117;
    const MAX_TRIES: u16 = 20;

    for offset in 0..MAX_TRIES {
        let port = BASE_PORT + offset;
        let addr = format!("127.0.0.1:{}", port);
        // 能绑上说明该端口空闲；绑上后立即 drop 释放，
        // 端口随后交给后端 sidecar 去真正监听。
        if let Ok(listener) = TcpListener::bind(addr.as_str()) {
            drop(listener);
            return port;
        }
    }

    // 兜底：固定端口全被占用时，让系统随机分配一个空闲端口。
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(BASE_PORT)
}

/// 轮询等待后端就绪（TCP 能连上即说明 Express 已在监听）
fn wait_ready(port: u16, timeout: Duration) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(parsed) = addr.parse() {
            if TcpStream::connect_timeout(&parsed, Duration::from_millis(400)).is_ok() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            let port = pick_port();
            let handle = app.handle().clone();

            // 拉起后端 sidecar
            let cmd = app
                .shell()
                .sidecar("xinyu-backend")?
                .env("NO_BROWSER", "1")
                .env("PORT", port.to_string());
            let (mut rx, child) = cmd.spawn()?;
            app.state::<Backend>().0.lock().unwrap().replace(child);

            // 转发后端日志，方便排查
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = rx.recv().await {
                    match ev {
                        CommandEvent::Stdout(line) => {
                            println!("[backend] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        _ => {}
                    }
                }
            });

            // 就绪后把窗口从闪屏切到真正的界面
            let win_handle = handle.clone();
            std::thread::spawn(move || {
                let ready = wait_ready(port, Duration::from_secs(90));
                if !ready {
                    eprintln!("[shell] 后端在 90 秒内没有就绪");
                }
                let url = format!("http://127.0.0.1:{}", port);
                if let Ok(parsed) = url.parse::<tauri::Url>() {
                    if let Some(win) = win_handle.get_webview_window("main") {
                        let _ = win.navigate(parsed);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("守岸人启动失败");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<Backend>() {
                if let Some(child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
