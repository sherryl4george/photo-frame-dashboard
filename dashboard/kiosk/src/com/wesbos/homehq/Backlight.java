package com.wesbos.homehq;

import android.content.Context;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.util.Log;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.concurrent.TimeUnit;

/**
 * "Screen off" by turning the panel's backlight to 0 through root (su), for frames where su works
 * without a prompt. The frame stays awake, Wi-Fi and the page keep running, and the touchscreen
 * still reports touches, so a tap wakes it (the page does that). Measured on a Pastigio FRAME156
 * (RK3326): /sys/class/backlight/backlight/brightness, 0-255; touch events kept arriving at 0.
 *
 * Safety: the level to go back to is saved before going dark, "dark" is remembered on disk, and the
 * kiosk puts the level back when it pauses, is destroyed, or starts after being killed while dark.
 * All methods block (they run su): call them off the UI thread. Only fixed strings and integers
 * reach the shell.
 */
final class Backlight {
  private static final String TAG = "HomeHQ.Backlight";
  private static final String DIR = "/sys/class/backlight";
  private static final String K_SAVED = "bl_saved", K_DARK = "bl_dark", K_AUTO = "bl_auto";

  private final Context ctx;
  private final SharedPreferences prefs;
  private String path; // /sys/class/backlight/<name>/brightness, found on first use
  private volatile boolean dark;

  Backlight(Context ctx) {
    this.ctx = ctx.getApplicationContext();
    this.prefs = this.ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
  }

  boolean isDark() { return dark; }

  /** The brightness file, or null when this device has none. */
  private synchronized String path() {
    if (path != null) return path;
    String[] names = new File(DIR).list();
    if (names == null) return null;
    java.util.Arrays.sort(names);
    for (String n : names) {
      if (n.matches("[A-Za-z0-9_.-]+") && new File(DIR + "/" + n + "/brightness").exists()) {
        path = DIR + "/" + n + "/brightness";
        return path;
      }
    }
    return null;
  }

  private int read() {
    String p = path();
    if (p == null) return -1;
    try (BufferedReader r = new BufferedReader(new FileReader(p))) {
      return Integer.parseInt(r.readLine().trim());
    } catch (Exception e) {
      return -1;
    }
  }

  private boolean su(String command) {
    try {
      Process pr = Runtime.getRuntime().exec(new String[] {"su", "-c", command});
      if (!pr.waitFor(4, TimeUnit.SECONDS)) { pr.destroy(); return false; }
      return pr.exitValue() == 0;
    } catch (Exception e) {
      Log.w(TAG, "su failed: " + e);
      return false;
    }
  }

  private boolean write(int level) {
    String p = path();
    if (p == null) return false;
    return su("echo " + level + " > " + p) && read() == level;
  }

  /** Backlight to 0. Auto-brightness is switched to manual meanwhile, or Android pushes the level back up. */
  void goDark() {
    if (path() == null) return;
    if (!dark) {
      int cur = read();
      if (cur > 5) prefs.edit().putInt(K_SAVED, cur).apply();
      boolean auto = Settings.System.getInt(ctx.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS_MODE, 0) == 1;
      if (auto) su("settings put system screen_brightness_mode 0");
      prefs.edit().putBoolean(K_DARK, true).putBoolean(K_AUTO, auto).apply();
    }
    dark = write(0) || dark;
    Log.i(TAG, "dark=" + dark);
  }

  /** Put the level (and auto-brightness) back. */
  void restore() {
    if (path() == null) return;
    int level = prefs.getInt(K_SAVED, 200);
    if (level <= 5) level = 200;
    write(level);
    if (prefs.getBoolean(K_AUTO, false)) su("settings put system screen_brightness_mode 1");
    prefs.edit().putBoolean(K_DARK, false).putBoolean(K_AUTO, false).apply();
    dark = false;
    Log.i(TAG, "restored to " + level);
  }

  /** Called while dark, every second or so: Android sometimes writes the level back. */
  void enforce() {
    if (dark && read() > 0) write(0);
  }

  /** At start: if the kiosk died while dark, the panel is still black. */
  void recover() {
    if (prefs.getBoolean(K_DARK, false)) restore();
  }
}
