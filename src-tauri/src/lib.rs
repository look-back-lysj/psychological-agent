// 心屿 · Tauri 桌面外壳
//
// 启动流程：
//   1) 挑一个空闲端口；
//   2) 拉起 Node 后端 sidecar（打包后的 心屿.exe，自带 public/ 与依赖）；
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

/// 让系统分配一个空闲端口
fn pick_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(34117)
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
        .expect("心屿启动失败");

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
