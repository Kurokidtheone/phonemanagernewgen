//! JNI entry points for dz.phonestoremanager.app.mobile.PsmCore (see PsmCorePlugin.kt). Each one catches panics:
//! a bug must come back as an error answer, never take the app down.
use crate::bridge;
use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use std::panic::{catch_unwind, AssertUnwindSafe};

fn read(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(|j| j.into()).unwrap_or_default()
}

fn answer(env: &mut JNIEnv, work: impl FnOnce() -> String) -> jstring {
    let text = catch_unwind(AssertUnwindSafe(work))
        .unwrap_or_else(|_| r#"{"ok":false,"error":{"code":"unexpected","params":{}}}"#.to_owned());
    env.new_string(text)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_dz_phonestoremanager_app_mobile_PsmCore_nativeInit(
    mut env: JNIEnv,
    _: JClass,
    files_dir: JString,
    machine_id: JString,
    version: JString,
) -> jstring {
    let (a, b, c) = (
        read(&mut env, &files_dir),
        read(&mut env, &machine_id),
        read(&mut env, &version),
    );
    answer(&mut env, || bridge::init(&a, &b, &c))
}

#[no_mangle]
pub extern "system" fn Java_dz_phonestoremanager_app_mobile_PsmCore_nativeRun(
    mut env: JNIEnv,
    _: JClass,
    channel: JString,
    payload: JString,
) -> jstring {
    let (c, p) = (read(&mut env, &channel), read(&mut env, &payload));
    answer(&mut env, || bridge::run(&c, &p))
}

#[no_mangle]
pub extern "system" fn Java_dz_phonestoremanager_app_mobile_PsmCore_nativeExportBackup(
    mut env: JNIEnv,
    _: JClass,
    destination: JString,
) -> jstring {
    let d = read(&mut env, &destination);
    answer(&mut env, || bridge::export_backup(&d))
}

#[no_mangle]
pub extern "system" fn Java_dz_phonestoremanager_app_mobile_PsmCore_nativeRestoreBackup(
    mut env: JNIEnv,
    _: JClass,
    source: JString,
) -> jstring {
    let s = read(&mut env, &source);
    answer(&mut env, || bridge::restore_backup(&s))
}

#[no_mangle]
pub extern "system" fn Java_dz_phonestoremanager_app_mobile_PsmCore_nativeLastExported(
    mut env: JNIEnv,
    _: JClass,
) -> jstring {
    answer(&mut env, || bridge::last_exported().unwrap_or_default())
}

#[no_mangle]
pub extern "system" fn Java_dz_phonestoremanager_app_mobile_PsmCore_nativeWipe(
    mut env: JNIEnv,
    _: JClass,
    files_dir: JString,
) -> jstring {
    let d = read(&mut env, &files_dir);
    answer(&mut env, || bridge::wipe_data(&d))
}

#[no_mangle]
pub extern "system" fn Java_dz_phonestoremanager_app_mobile_PsmCore_nativeShutdown(
    _env: JNIEnv,
    _: JClass,
) {
    bridge::shutdown();
}
