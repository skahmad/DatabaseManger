package com.forgesystem.dbmanager;

/**
 * Entry point — launches the desktop app with an embedded HTML WebView.
 * Kept separate from {@link DesktopApp} so JavaFX module loading works reliably.
 */
public final class Launcher {
    private Launcher() {
    }

    public static void main(String[] args) {
        DesktopApp.main(args);
    }
}
