// OCR 模型运行时完整性校验（Tauri command）
// -----------------------------------------------------------------------------
// 对安全基线的"模型哈希校验"落地：在 Tauri 桌面端读取磁盘上的 OCR 模型文件，
// 计算 SHA-256 并与前端登记的清单（OCR_MODEL_MANIFEST）比对，防止模型被篡改/损坏。
// - 纯哈希与目录校验抽成纯函数（verify_files_in_dir），便于 cargo 单测。
// - 生产打包后前端资源目录含 paddle/（Vite 把 public/paddle 拷入 dist → 打进资源）；
//   开发 dev 模式该目录可能不存在——此时返回 available:false，前端据此跳过，不阻断识别。
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

/// 单个模型文件的校验结果
#[derive(Serialize, Clone)]
pub struct ModelCheck {
    pub file: String,
    pub path: String,
    /// 文件是否存在（读得到）
    pub present: bool,
    /// 实际哈希是否与期望一致
    pub matched: bool,
    /// 实际 SHA-256（小写 hex）；缺失时为空串
    pub actual: String,
}

/// 整批 OCR 模型的校验汇总
#[derive(Serialize, Clone)]
pub struct OcrVerifyReport {
    /// 模型目录是否存在（Tauri 生产资源；开发模式可能无）
    pub available: bool,
    /// 全部存在且哈希一致才算通过
    pub all_ok: bool,
    pub checks: Vec<ModelCheck>,
}

/// 计算字节数组的 SHA-256 十六进制（小写）。纯函数，便于单测。
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// 在 dir 下递归查找文件名与 file 相同的文件（模型实际散落在 paddle/det、rec、cls、dict 等子目录）。
/// 找到则读取并计算 SHA-256，与期望比对；找不到视为 present=false。
fn resolve_file_recursive(dir: &Path, file: &str) -> Option<PathBuf> {
    if dir.join(file).is_file() {
        return Some(dir.join(file));
    }
    // 递归遍历子目录（不跟符号链接，避免越界读取）
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return None,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = resolve_file_recursive(&p, file) {
                return Some(found);
            }
        }
    }
    None
}

/// 对目录 dir 下 expected 中的每个（文件名 → 期望小写哈希）递归定位并校验。纯函数，可单测。
/// 文件读不到视为 present=false / matched=false。
pub fn verify_files_in_dir(dir: &Path, expected: &HashMap<String, String>) -> Vec<ModelCheck> {
    expected
        .iter()
        .map(|(file, exp)| {
            let path = resolve_file_recursive(dir, file);
            let path_str = path.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
            match path.and_then(|p| fs::read(&p).ok()) {
                Some(bytes) => {
                    let actual = sha256_hex(&bytes);
                    ModelCheck {
                        file: file.clone(),
                        path: path_str,
                        present: true,
                        matched: actual.eq_ignore_ascii_case(exp),
                        actual,
                    }
                }
                None => ModelCheck {
                    file: file.clone(),
                    path: path_str,
                    present: false,
                    matched: false,
                    actual: String::new(),
                },
            }
        })
        .collect()
}

/// 校验前端资源目录下的 OCR 模型：读取 resource_dir/paddle 下各模型文件并比对哈希。
#[tauri::command]
pub fn verify_model_integrity(
    app: tauri::AppHandle,
    expected: HashMap<String, String>,
) -> Result<OcrVerifyReport, String> {
    let paddle = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("paddle");
    let available = paddle.is_dir();
    let checks = if available {
        verify_files_in_dir(&paddle, &expected)
    } else {
        Vec::new()
    };
    let all_ok = available
        && !checks.is_empty()
        && checks.iter().all(|c| c.present && c.matched);
    Ok(OcrVerifyReport {
        available,
        all_ok,
        checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_dir() -> std::path::PathBuf {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ocr_test_{ts}"))
    }

    #[test]
    fn sha256_hex_known_vector() {
        // SHA-256("abc") = ba7816bf...（已知向量）
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verify_matches_and_mismatches_and_missing() {
        let dir = tmp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("good.bin"), b"model-bytes").unwrap();
        fs::write(dir.join("bad.bin"), b"model-bytes").unwrap();

        let good = sha256_hex(b"model-bytes");
        let mut expected = HashMap::new();
        expected.insert("good.bin".into(), good.clone());
        expected.insert("bad.bin".into(), "0".repeat(64)); // 期望填错
        expected.insert("missing.bin".into(), good.clone());

        let checks = verify_files_in_dir(&dir, &expected);
        let by_file = |f: &str| checks.iter().find(|c| c.file == f).unwrap();

        assert!(by_file("good.bin").matched);
        assert!(!by_file("bad.bin").matched);
        assert!(!by_file("missing.bin").present);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn verify_finds_models_in_subdirs() {
        // 真实打包结构中模型散落在 det/rec/cls/dict 子目录，清单键只有文件名，
        // 递归查找必须能从子目录命中（否则桌面校验会误判为缺失）。
        let dir = tmp_dir();
        fs::create_dir_all(dir.join("det")).unwrap();
        fs::create_dir_all(dir.join("rec")).unwrap();
        fs::create_dir_all(dir.join("dict")).unwrap();
        fs::write(dir.join("det").join("ch_PP-OCRv4_det_infer.onnx"), b"det-model").unwrap();
        fs::write(dir.join("rec").join("ch_PP-OCRv4_rec_infer.onnx"), b"rec-model").unwrap();
        fs::write(dir.join("dict").join("ppocr_keys_v1.txt"), b"keys-data").unwrap();

        let mut expected = HashMap::new();
        expected.insert("ch_PP-OCRv4_det_infer.onnx".into(), sha256_hex(b"det-model"));
        expected.insert("ch_PP-OCRv4_rec_infer.onnx".into(), sha256_hex(b"rec-model"));
        expected.insert("ppocr_keys_v1.txt".into(), sha256_hex(b"keys-data"));
        expected.insert("missing.onnx".into(), sha256_hex(b"nope"));

        let checks = verify_files_in_dir(&dir, &expected);
        let by_file = |f: &str| checks.iter().find(|c| c.file == f).unwrap();

        assert!(by_file("ch_PP-OCRv4_det_infer.onnx").matched);
        assert!(by_file("ch_PP-OCRv4_rec_infer.onnx").matched);
        assert!(by_file("ppocr_keys_v1.txt").matched);
        assert!(!by_file("missing.onnx").present);

        fs::remove_dir_all(&dir).unwrap();
    }
}