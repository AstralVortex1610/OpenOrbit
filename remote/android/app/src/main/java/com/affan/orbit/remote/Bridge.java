package com.affan.orbit.remote;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** What the page can ask of the phone (window.OrbitAndroid). Never holds API keys: only the pairing. */
public class Bridge {
    private static final String ALIAS = "orbit_remote_link";
    private final Activity act;
    private final WebView web;
    private final SharedPreferences prefs;
    private TextToSpeech tts;
    private volatile boolean ttsReady;

    Bridge(Activity act, WebView web) {
        this.act = act; this.web = web;
        this.prefs = act.getSharedPreferences("orbit_remote", Activity.MODE_PRIVATE);
        this.tts = new TextToSpeech(act, st -> ttsReady = st == TextToSpeech.SUCCESS);
    }

    void shutdown() { if (tts != null) { tts.stop(); tts.shutdown(); tts = null; } }

    // ---- storage: the pairing (device id + secret) is encrypted with a key that lives in the Android Keystore ----
    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            kg.generateKey();
        }
        return (SecretKey) ks.getKey(ALIAS, null);
    }

    @JavascriptInterface
    public String getItem(String k) {
        String v = prefs.getString(k, null);
        if (v == null) return null;
        try {
            String[] p = v.split(":", 2);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(p[0], Base64.NO_WRAP)));
            return new String(c.doFinal(Base64.decode(p[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; } // key gone (e.g. app data restored elsewhere): pair again
    }

    @JavascriptInterface
    public void setItem(String k, String v) {
        if (v == null) { removeItem(k); return; }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] ct = c.doFinal(v.getBytes(StandardCharsets.UTF_8));
            prefs.edit().putString(k, Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)).apply();
        } catch (Exception e) { throw new RuntimeException("secure storage failed", e); }
    }

    @JavascriptInterface
    public void removeItem(String k) { prefs.edit().remove(k).apply(); }

    // ---- the phone's own voice for spoken replies ----
    @JavascriptInterface
    public void speak(String text) {
        if (tts == null || !ttsReady || text == null) return;
        int max = Math.max(500, TextToSpeech.getMaxSpeechInputLength() - 100);
        tts.stop();
        String rest = text;
        int n = 0;
        while (!rest.isEmpty()) {
            int cut = rest.length() <= max ? rest.length() : Math.max(rest.lastIndexOf(". ", max) + 1, max / 2);
            tts.speak(rest.substring(0, cut), TextToSpeech.QUEUE_ADD, null, "orbit-" + (n++));
            rest = rest.substring(cut).trim();
        }
    }

    @JavascriptInterface
    public void stopSpeaking() { if (tts != null) tts.stop(); }

    @JavascriptInterface
    public boolean isSpeaking() { return tts != null && tts.isSpeaking(); }

    @JavascriptInterface
    public String deviceName() {
        String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String model = Build.MODEL == null ? "Android" : Build.MODEL;
        if (!m.isEmpty() && !model.toLowerCase().startsWith(m.toLowerCase())) model = Character.toUpperCase(m.charAt(0)) + m.substring(1) + " " + model;
        return model;
    }

    // ---- files from the laptop: saved to Downloads/Orbit and opened ----
    @JavascriptInterface
    public String saveFile(String name, String mime, String b64) {
        try {
            byte[] data = Base64.decode(b64, Base64.DEFAULT);
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
            cv.put(MediaStore.Downloads.MIME_TYPE, mime);
            cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Orbit");
            ContentResolver cr = act.getContentResolver();
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) throw new Exception("no space in Downloads");
            try (OutputStream os = cr.openOutputStream(uri)) { os.write(data); }
            act.runOnUiThread(() -> {
                Intent v = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try { act.startActivity(v); } catch (Exception e) { Toast.makeText(act, "Saved to Downloads/Orbit/" + name, Toast.LENGTH_LONG).show(); }
            });
            return "Downloads/Orbit/" + name;
        } catch (Exception e) {
            act.runOnUiThread(() -> Toast.makeText(act, "Couldn't save " + name + ": " + e.getMessage(), Toast.LENGTH_LONG).show());
            return "";
        }
    }
}
