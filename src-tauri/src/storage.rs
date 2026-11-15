//! Save-file storage, confined to `<app data>/saves`.
//! The frontend never receives file-system access: it can only name a save with a
//! strictly validated identifier, and contents are opaque text (never executed).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MAX_SAVE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SAVES: usize = 500;

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 48
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn file_of(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("Nom de sauvegarde invalide.".into());
    }
    Ok(dir.join(format!("{name}.json")))
}

pub fn list(dir: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if valid_name(stem) {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

pub fn read(dir: &Path, name: &str) -> Result<String, String> {
    let path = file_of(dir, name)?;
    let meta = fs::metadata(&path).map_err(|_| "Sauvegarde introuvable.".to_string())?;
    if meta.len() as usize > MAX_SAVE_BYTES {
        return Err("Sauvegarde trop volumineuse.".into());
    }
    fs::read_to_string(&path).map_err(|e| format!("Lecture impossible : {e}"))
}

/// Atomic write: the data goes to a temporary file, is flushed to disk, then renamed over
/// the destination, so an interrupted write never leaves a truncated save.
pub fn write(dir: &Path, name: &str, text: &str) -> Result<(), String> {
    if text.len() > MAX_SAVE_BYTES {
        return Err("Sauvegarde trop volumineuse.".into());
    }
    let path = file_of(dir, name)?;
    fs::create_dir_all(dir).map_err(|e| format!("Dossier de sauvegarde inaccessible : {e}"))?;
    if !path.exists() && list(dir)?.len() >= MAX_SAVES {
        return Err("Trop de sauvegardes : supprimez-en d'abord.".into());
    }
    let tmp = dir.join(format!("{name}.json.tmp"));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("Écriture impossible : {e}"))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("Écriture impossible : {e}"))?;
        f.sync_all().map_err(|e| format!("Écriture impossible : {e}"))?;
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Écriture impossible : {e}")
    })
}

pub fn delete(dir: &Path, name: &str) -> Result<(), String> {
    let path = file_of(dir, name)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Suppression impossible : {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bastides-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn names_are_strictly_validated() {
        assert!(valid_name("partie-2026_01"));
        for bad in ["", "..", "../x", "a/b", "a\\b", "a.b", "C:x", "nul\0", &"x".repeat(49)] {
            assert!(!valid_name(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn write_read_list_delete_roundtrip() {
        let dir = temp_dir("rw");
        assert!(list(&dir).unwrap().is_empty());
        write(&dir, "a", "{\"x\":1}").unwrap();
        write(&dir, "b", "two").unwrap();
        write(&dir, "a", "{\"x\":2}").unwrap(); // overwrite atomically
        assert_eq!(read(&dir, "a").unwrap(), "{\"x\":2}");
        assert_eq!(list(&dir).unwrap(), vec!["a".to_string(), "b".to_string()]);
        assert!(!dir.join("a.json.tmp").exists());
        assert!(write(&dir, "../evil", "x").is_err());
        assert!(read(&dir, "..").is_err());
        assert!(write(&dir, "big", &"x".repeat(MAX_SAVE_BYTES + 1)).is_err());
        delete(&dir, "a").unwrap();
        delete(&dir, "a").unwrap();
        assert!(read(&dir, "a").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
