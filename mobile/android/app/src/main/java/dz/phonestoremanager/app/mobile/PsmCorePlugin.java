package dz.phonestoremanager.app.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The bridge between the web app and the Rust core on this phone (stand-alone mode), plus the few Android things the
 * core cannot do itself: the machine id, the share menu (WhatsApp first) and the file picker for a backup.
 */
@CapacitorPlugin(name = "PsmCore")
public class PsmCorePlugin extends Plugin {
    // One worker: the core serializes its calls anyway, and the web view's thread must never wait for the database.
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    /** Opens the data and starts the core. The device id comes from Settings.Secure.ANDROID_ID. */
    @PluginMethod
    public void start(PluginCall call) {
        worker.execute(() -> {
            try {
                String androidId = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
                if (androidId == null) androidId = "";
                String version = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
                String result = PsmCore.nativeInit(getContext().getFilesDir().getAbsolutePath(), androidId, version == null ? "0" : version);
                JSObject out = new JSObject();
                out.put("result", result);
                call.resolve(out);
            } catch (Throwable t) {
                call.reject(String.valueOf(t.getMessage()));
            }
        });
    }

    /** One channel call: { channel, payload (JSON text) } -> { result (JSON text) }. */
    @PluginMethod
    public void run(PluginCall call) {
        final String channel = call.getString("channel", "");
        final String payload = call.getString("payload", "");
        worker.execute(() -> {
            JSObject out = new JSObject();
            out.put("result", PsmCore.nativeRun(channel, payload));
            call.resolve(out);
        });
    }

    /** Builds the backup zip in the cache folder and returns its path for the share menu. */
    @PluginMethod
    public void exportBackup(PluginCall call) {
        final String name = call.getString("name", "backup.zip").replaceAll("[^A-Za-z0-9._-]", "_");
        worker.execute(() -> {
            File dir = new File(getContext().getCacheDir(), "exports");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File file = new File(dir, name);
            JSObject out = new JSObject();
            out.put("result", PsmCore.nativeExportBackup(file.getAbsolutePath()));
            out.put("path", file.getAbsolutePath());
            call.resolve(out);
        });
    }

    /** Asks the person to pick a backup zip, copies it to the cache and restores it. */
    @PluginMethod
    public void restoreBackup(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"application/zip", "application/x-zip-compressed", "application/octet-stream"});
        startActivityForResult(call, intent, "backupPicked");
    }

    @ActivityCallback
    private void backupPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        final Uri uri = result.getData().getData();
        worker.execute(() -> {
            try {
                File copy = new File(getContext().getCacheDir(), "restore.zip");
                try (InputStream in = getContext().getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(copy)) {
                    byte[] buffer = new byte[64 * 1024];
                    int n;
                    while (in != null && (n = in.read(buffer)) > 0) out.write(buffer, 0, n);
                }
                JSObject out = new JSObject();
                out.put("result", PsmCore.nativeRestoreBackup(copy.getAbsolutePath()));
                //noinspection ResultOfMethodCallIgnored
                copy.delete();
                call.resolve(out);
            } catch (Throwable t) {
                call.reject(String.valueOf(t.getMessage()));
            }
        });
    }

    /** Erases this phone's own data: moving to a shop PC. */
    @PluginMethod
    public void wipe(PluginCall call) {
        worker.execute(() -> {
            JSObject out = new JSObject();
            out.put("result", PsmCore.nativeWipe(getContext().getFilesDir().getAbsolutePath()));
            call.resolve(out);
        });
    }

    /** When the last backup was exported (ISO text) or "". */
    @PluginMethod
    public void lastExported(PluginCall call) {
        JSObject out = new JSObject();
        out.put("value", PsmCore.nativeLastExported());
        call.resolve(out);
    }

    /** Writes a picture or PDF the web app made (base64) to the cache, then shares it like shareFile. */
    @PluginMethod
    public void shareBase64(PluginCall call) {
        String data = call.getString("base64");
        String name = call.getString("name", "document.png").replaceAll("[^A-Za-z0-9._-]", "_");
        if (data == null) {
            call.reject("base64");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), "exports");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File file = new File(dir, name);
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(android.util.Base64.decode(data, android.util.Base64.DEFAULT));
            }
            call.getData().put("path", file.getAbsolutePath());
            shareFile(call);
        } catch (Throwable t) {
            call.reject(String.valueOf(t.getMessage()));
        }
    }

    /**
     * The Android share menu for a file in the cache (a receipt image or PDF, a backup). With a WhatsApp number the
     * chat with that customer opens directly when WhatsApp is installed; otherwise the usual menu.
     */
    @PluginMethod
    public void shareFile(PluginCall call) {
        String path = call.getString("path");
        String mime = call.getString("mime", "application/octet-stream");
        String title = call.getString("title", "");
        String number = call.getString("whatsapp", "").replaceAll("[^0-9]", "");
        if (path == null) {
            call.reject("path");
            return;
        }
        File file = new File(path);
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mime);
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.putExtra(Intent.EXTRA_SUBJECT, title);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            if (!number.isEmpty() && isInstalled("com.whatsapp")) {
                send.setPackage("com.whatsapp");
                send.putExtra("jid", number + "@s.whatsapp.net");
                getActivity().startActivity(send);
            } else {
                Intent chooser = Intent.createChooser(send, title);
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(chooser);
            }
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no_share_target");
        }
    }

    private boolean isInstalled(String pkg) {
        try {
            getContext().getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    @Override
    protected void handleOnDestroy() {
        worker.shutdown();
    }
}
