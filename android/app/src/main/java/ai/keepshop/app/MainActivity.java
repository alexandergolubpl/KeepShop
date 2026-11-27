package ai.keepshop.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkUpdaterPlugin.class); // обновление из GitHub Releases
        super.onCreate(savedInstanceState);
    }
}
