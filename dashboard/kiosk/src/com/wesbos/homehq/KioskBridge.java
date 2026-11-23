package com.wesbos.homehq;

import android.content.Context;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.webkit.JavascriptInterface;

/**
 * What the dashboard page may ask of the kiosk, as window.HomeHQKiosk: turn the screen off or on,
 * restart the frame (root), and read a few harmless details. It only answers while the page shown is the saved dashboard
 * address (see MainActivity.pageIsDashboard), so a page reached any other way gets nothing.
 */
final class KioskBridge {
  static final String VERSION = "1.9";
  private final MainActivity act;
  private final Backlight backlight;

  KioskBridge(MainActivity act, Backlight backlight) {
    this.act = act;
    this.backlight = backlight;
  }

  private static String esc(String s) {
    return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"").replaceAll("[\\u0000-\\u001f]", " ");
  }

  /** JSON: kiosk version, model, Android version, Wi-Fi signal (dBm) and whether the screen is on. */
  @JavascriptInterface
  public String info() {
    if (!act.pageIsDashboard()) return "{\"kiosk\":\"" + VERSION + "\",\"screenOn\":true}";
    int rssi = 0;
    try {
      WifiManager wm = (WifiManager) act.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
      WifiInfo wi = wm == null ? null : wm.getConnectionInfo();
      if (wi != null) rssi = wi.getRssi();
    } catch (RuntimeException e) { /* no Wi-Fi permission or service: leave it out */ }
    return "{\"kiosk\":\"" + VERSION + "\",\"model\":\"" + esc(Build.MODEL) + "\",\"android\":\"" + esc(Build.VERSION.RELEASE) + "\""
        + (rssi < 0 ? ",\"rssi\":" + rssi : "") + ",\"screenoff\":\"backlight\",\"screenOn\":" + !backlight.isDark() + "}";
  }

  /** Backlight off (the screen still takes taps) or back to normal. */
  @JavascriptInterface
  public void setScreenOff(final boolean off) {
    if (!act.pageIsDashboard()) return;
    act.runOnUiThread(new Runnable() { public void run() { act.setScreenOff(off); } });
  }

  /**
   * Restart the frame through root (su). Only for frames where su works without a prompt. The WebView
   * keeps cookies (the dashboard login) in memory and writes them to disk later, so they are saved and
   * the disk synced first; a restart straight away can lose the login.
   */
  @JavascriptInterface
  public void reboot() {
    if (!act.pageIsDashboard()) return;
    act.runOnUiThread(new Runnable() { public void run() {
      try { android.webkit.CookieManager.getInstance().flush(); } catch (RuntimeException e) { /* nothing to save */ }
    } });
    new Thread(new Runnable() {
      public void run() {
        try {
          Thread.sleep(3000);
          Runtime.getRuntime().exec(new String[] {"su", "-c", "sync; sleep 1; sync; reboot"});
        } catch (Exception e) { android.util.Log.w("HomeHQ", "reboot failed: " + e); }
      }
    }).start();
  }
}
