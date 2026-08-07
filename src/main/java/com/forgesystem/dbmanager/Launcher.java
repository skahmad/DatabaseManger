package com.forgesystem.dbmanager;

/**
 * Entry point — launches the desktop app with an embedded HTML WebView.
 * Kept separate from {@link DesktopApp} so JavaFX module loading works reliably.
 *
 * <p>Mac app-menu naming must happen here (and via JVM flags) before any toolkit
 * classes load, otherwise the system menu stays titled {@code java}.
 */
public final class Launcher {
    public static final String APP_NAME = "DB Pilot";

    static {
        configureMacAppName();
    }

    private Launcher() {
    }

    /** Best-effort rename of the macOS application menu / dock label. */
    static void configureMacAppName() {
        System.setProperty("apple.awt.application.name", APP_NAME);
        System.setProperty("apple.laf.useScreenMenuBar", "true");
        // Legacy Apple MRJ property still honored by some runtimes.
        System.setProperty("com.apple.mrj.application.apple.menu.about.name", APP_NAME);
    }

    /**
     * After the JavaFX toolkit is up, push the name into Glass as well.
     * Safe no-op on non-macOS or when internals are unavailable.
     */
    static void applyNativeAppName() {
        configureMacAppName();
        try {
            Class<?> appClass = Class.forName("com.sun.glass.ui.Application");
            Object app = appClass.getMethod("GetApplication").invoke(null);
            if (app != null) {
                appClass.getMethod("setName", String.class).invoke(app, APP_NAME);
            }
        } catch (Throwable ignored) {
            // Not JavaFX Glass, or not macOS — ignore.
        }
    }

    public static void main(String[] args) {
        configureMacAppName();
        DesktopApp.main(args);
    }
}
