package dz.phonestoremanager.app.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PsmCorePlugin.class); // the Rust core, for the stand-alone edition
        registerPlugin(BtPrinterPlugin.class); // Bluetooth thermal printer
        super.onCreate(savedInstanceState);
    }
}
