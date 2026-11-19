package com.affan.orbit.remote;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/**
 * Orbit Remote: a WebView around the Orbit desktop UI (bundled in assets/www by remote/build.js).
 * All work happens on the laptop; this shell only adds what a WebView can't do alone:
 * file picking, mic/camera permissions, Keystore-backed storage, the phone's voice and downloads (Bridge).
 */
public class MainActivity extends Activity {
    private static final int REQ_FILE = 1, REQ_PERM = 2;
    private WebView web;
    private Bridge bridge;
    private ValueCallback<Uri[]> fileCb;
    private PermissionRequest pendingPerm;
    private String pendingLink;
    private boolean loaded;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);              // the UI is in file:///android_asset/www
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false); // the Orbiter frame talks to the page by postMessage, not shared origin
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        bridge = new Bridge(this, web);
        web.addJavascriptInterface(bridge, "OrbitAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("file".equals(u.getScheme())) return false;
                if ("orbitremote".equals(u.getScheme())) { deliverLink(u.toString()); return true; }
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
                return true;
            }
            @Override
            public void onPageFinished(WebView view, String url) { loaded = true; if (pendingLink != null) deliverLink(pendingLink); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest req) {
                List<String> need = new ArrayList<>();
                for (String r : req.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO);
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.CAMERA);
                }
                if (need.isEmpty()) { req.grant(req.getResources()); return; }
                pendingPerm = req;
                requestPermissions(need.toArray(new String[0]), REQ_PERM);
            }
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(Intent.createChooser(i, "Send to your laptop"), REQ_FILE); }
                catch (ActivityNotFoundException e) { fileCb = null; return false; }
                return true;
            }
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) { Log.d("OrbitRemote", m.message()); return true; }
        });
        handleIntent(getIntent());
        web.loadUrl("file:///android_asset/www/index.html");
    }

    private void handleIntent(Intent i) {
        if (i != null && Intent.ACTION_VIEW.equals(i.getAction()) && i.getData() != null && "orbitremote".equals(i.getData().getScheme())) {
            pendingLink = i.getData().toString();
            if (loaded) deliverLink(pendingLink);
        }
    }

    private void deliverLink(String link) {
        pendingLink = null;
        String q = JSONObject.quote(link);
        web.evaluateJavascript("window.OrbitRemoteDeepLink=" + q + ";window.OrbitRemotePairLink&&OrbitRemotePairLink(" + q + ")", null);
    }

    @Override
    protected void onNewIntent(Intent i) { super.onNewIntent(i); setIntent(i); handleIntent(i); }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != REQ_FILE || fileCb == null) return;
        Uri[] uris = null;
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                uris = new Uri[n];
                for (int k = 0; k < n; k++) uris[k] = data.getClipData().getItemAt(k).getUri();
            } else if (data.getData() != null) uris = new Uri[] { data.getData() };
        }
        fileCb.onReceiveValue(uris);
        fileCb = null;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code != REQ_PERM || pendingPerm == null) return;
        List<String> ok = new ArrayList<>();
        for (String r : pendingPerm.getResources()) {
            String p = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) ? Manifest.permission.RECORD_AUDIO : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) ? Manifest.permission.CAMERA : null;
            if (p != null && checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) ok.add(r);
        }
        if (ok.isEmpty()) pendingPerm.deny(); else pendingPerm.grant(ok.toArray(new String[0]));
        pendingPerm = null;
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(function(){var c=document.querySelector('#computer:not([hidden]) #compClose, .overlay .close, #rmGate:not([hidden]) #rgCamStop');if(c&&c.offsetParent){c.click();return 1}var a=document.querySelector('.rail-btn.active');if(a&&a.dataset.view!=='home'){document.querySelector('.rail-btn[data-view=home]').click();return 1}return 0})()",
            v -> { if (!"1".equals(v)) moveTaskToBack(true); });
    }

    @Override
    protected void onDestroy() { if (bridge != null) bridge.shutdown(); if (web != null) web.destroy(); super.onDestroy(); }
}
