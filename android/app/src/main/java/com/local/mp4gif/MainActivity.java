package com.local.mp4gif;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FFmpegBridgePlugin.class);
        registerPlugin(GifskiPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
