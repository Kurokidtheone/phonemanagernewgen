package dz.phonestoremanager.app.mobile;

/** The Rust core (libpsm_android.so, built from mobile/core-android): JSON in, JSON out. See that crate's jni_glue.rs. */
public final class PsmCore {
    static {
        System.loadLibrary("psm_android");
    }

    private PsmCore() {}

    public static native String nativeInit(String filesDir, String machineId, String version);

    public static native String nativeRun(String channel, String payload);

    public static native String nativeExportBackup(String destination);

    public static native String nativeRestoreBackup(String source);

    public static native String nativeLastExported();

    public static native String nativeWipe(String filesDir);

    public static native void nativeShutdown();
}
