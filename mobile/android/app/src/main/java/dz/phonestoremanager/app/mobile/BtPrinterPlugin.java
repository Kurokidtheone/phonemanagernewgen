package dz.phonestoremanager.app.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A Bluetooth thermal receipt printer (58 or 80 mm, classic Bluetooth serial profile, ESC/POS). The printer is paired
 * once in Android's Bluetooth settings; this plugin lists the paired devices and sends a picture to one of them.
 * Errors are short codes the web app translates: bt_unavailable, bt_off, bt_permission, printer_unreachable, bad_image.
 */
@CapacitorPlugin(name = "BtPrinter", permissions = {@Permission(alias = "bluetooth", strings = {Manifest.permission.BLUETOOTH_CONNECT})})
public class BtPrinterPlugin extends Plugin {
    private static final UUID SERIAL = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private boolean needsPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    private BluetoothAdapter adapter() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    /** The paired devices: { devices: [{ name, address }] }. */
    @PluginMethod
    public void paired(PluginCall call) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", call, "pairedPermission");
            return;
        }
        listPaired(call);
    }

    @PermissionCallback
    private void pairedPermission(PluginCall call) {
        if (needsPermission()) call.reject("bt_permission");
        else listPaired(call);
    }

    @SuppressLint("MissingPermission")
    private void listPaired(PluginCall call) {
        BluetoothAdapter bt = adapter();
        if (bt == null) {
            call.reject("bt_unavailable");
            return;
        }
        if (!bt.isEnabled()) {
            call.reject("bt_off");
            return;
        }
        JSArray devices = new JSArray();
        try {
            Set<BluetoothDevice> bonded = bt.getBondedDevices();
            for (BluetoothDevice d : bonded) {
                JSObject o = new JSObject();
                o.put("name", d.getName() == null ? d.getAddress() : d.getName());
                o.put("address", d.getAddress());
                devices.put(o);
            }
        } catch (SecurityException e) {
            call.reject("bt_permission");
            return;
        }
        JSObject out = new JSObject();
        out.put("devices", devices);
        call.resolve(out);
    }

    /** Prints a PNG: { address, image (base64), dots (384 for 58 mm, 576 for 80 mm), cut? }. */
    @PluginMethod
    public void print(PluginCall call) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", call, "printPermission");
            return;
        }
        startPrint(call);
    }

    @PermissionCallback
    private void printPermission(PluginCall call) {
        if (needsPermission()) call.reject("bt_permission");
        else startPrint(call);
    }

    private void startPrint(PluginCall call) {
        final String address = call.getString("address", "");
        final String image = call.getString("image", "");
        final int dots = Math.max(8, (call.getInt("dots", 576) / 8) * 8);
        final boolean cut = Boolean.TRUE.equals(call.getBoolean("cut", false));
        worker.execute(() -> {
            try {
                byte[] job = prepare(image, dots, cut);
                send(address, job);
                call.resolve();
            } catch (PrintError e) {
                call.reject(e.code);
            } catch (Throwable t) {
                call.reject("printer_unreachable");
            }
        });
    }

    private static final class PrintError extends Exception {
        final String code;

        PrintError(String code) {
            super(code);
            this.code = code;
        }
    }

    private static byte[] prepare(String base64, int dots, boolean cut) throws PrintError {
        byte[] raw;
        try {
            raw = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            throw new PrintError("bad_image");
        }
        Bitmap source = BitmapFactory.decodeByteArray(raw, 0, raw.length);
        if (source == null || source.getWidth() <= 0) throw new PrintError("bad_image");
        int height = Math.max(1, Math.round(source.getHeight() * (dots / (float) source.getWidth())));
        Bitmap scaled = Bitmap.createScaledBitmap(source, dots, height, true);
        int[] pixels = new int[dots * height];
        scaled.getPixels(pixels, 0, dots, 0, 0, dots, height);
        return EscPos.job(pixels, dots, height, cut);
    }

    @SuppressLint("MissingPermission")
    private void send(String address, byte[] job) throws PrintError {
        BluetoothAdapter bt = adapter();
        if (bt == null) throw new PrintError("bt_unavailable");
        if (!bt.isEnabled()) throw new PrintError("bt_off");
        BluetoothDevice device;
        try {
            device = bt.getRemoteDevice(address);
        } catch (IllegalArgumentException e) {
            throw new PrintError("printer_unreachable");
        }
        BluetoothSocket socket = null;
        try {
            bt.cancelDiscovery(); // a running scan makes connecting slow and flaky
            socket = connect(device);
            OutputStream out = socket.getOutputStream();
            for (int at = 0; at < job.length; at += 512) {
                out.write(job, at, Math.min(512, job.length - at));
                out.flush();
                Thread.sleep(12); // let a small printer buffer drain
            }
            Thread.sleep(400); // closing at once would cut the end of the receipt
        } catch (SecurityException e) {
            throw new PrintError("bt_permission");
        } catch (Exception e) {
            throw new PrintError("printer_unreachable");
        } finally {
            if (socket != null) {
                try {
                    socket.close();
                } catch (Exception ignored) {
                    // nothing left to do
                }
            }
        }
    }

    /** The standard serial service first; some cheap printers only answer on channel 1, which needs the hidden call. */
    @SuppressLint("MissingPermission")
    private static BluetoothSocket connect(BluetoothDevice device) throws Exception {
        try {
            BluetoothSocket s = device.createRfcommSocketToServiceRecord(SERIAL);
            s.connect();
            return s;
        } catch (Exception first) {
            Method m = device.getClass().getMethod("createRfcommSocket", int.class);
            BluetoothSocket s = (BluetoothSocket) m.invoke(device, 1);
            s.connect();
            return s;
        }
    }
}
