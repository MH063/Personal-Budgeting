use std::fs;
use std::path::Path;
use std::process::{Command, exit};
use std::thread;
use std::time::Duration;

pub fn run_updater(pid: u32, zip_path: &Path, target_dir: &Path) {
    if !zip_path.exists() {
        eprintln!("Update package not found: {:?}", zip_path);
        exit(1);
    }

    // Wait for the main process to exit
    println!("Waiting for process {} to exit...", pid);
    for _ in 0..60 {
        if is_process_running(pid) {
            thread::sleep(Duration::from_millis(500));
        } else {
            break;
        }
    }

    // Give it a tiny extra time just to ensure file locks are released
    thread::sleep(Duration::from_millis(500));

    println!("Extracting update from {:?} to {:?}", zip_path, target_dir);
    if let Err(e) = extract_zip(zip_path, target_dir) {
        eprintln!("Failed to extract update: {}", e);
        exit(1);
    }

    println!("Extraction successful. Restarting main application...");
    
    // Attempt to delete the zip file
    let _ = fs::remove_file(zip_path);

    let main_exe = target_dir.join("moneybook.exe");
    if main_exe.exists() {
        let _ = Command::new(main_exe).spawn();
    }

    exit(0);
}

#[cfg(windows)]
fn is_process_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if let Ok(output) = Command::new("tasklist")
        .args(&["/FI", &format!("PID eq {}", pid)])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout.contains(&pid.to_string())
    } else {
        false
    }
}

#[cfg(not(windows))]
fn is_process_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
}

fn extract_zip(archive_path: &Path, target_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let file = fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let outpath = match file.enclosed_name() {
            Some(path) => target_dir.join(path),
            None => continue,
        };

        let name = file.name()?.to_string();
        if name.ends_with('/') {
            fs::create_dir_all(&outpath)?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    fs::create_dir_all(p)?;
                }
            }
            let mut outfile = fs::File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
        }
    }
    Ok(())
}
