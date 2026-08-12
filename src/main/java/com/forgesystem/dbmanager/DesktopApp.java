package com.forgesystem.dbmanager;

import com.forgesystem.dbmanager.web.ApiServer;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.scene.Scene;
import javafx.scene.control.Alert;
import javafx.scene.control.ButtonType;
import javafx.scene.control.Menu;
import javafx.scene.control.MenuBar;
import javafx.scene.control.MenuItem;
import javafx.scene.control.RadioMenuItem;
import javafx.scene.control.SeparatorMenuItem;
import javafx.scene.control.TextInputDialog;
import javafx.scene.control.ToggleGroup;
import javafx.scene.image.Image;
import javafx.scene.input.KeyCode;
import javafx.scene.input.KeyCodeCombination;
import javafx.scene.input.KeyCombination;
import javafx.scene.layout.BorderPane;
import javafx.scene.web.WebEngine;
import javafx.scene.web.WebView;
import javafx.stage.Stage;
import netscape.javascript.JSObject;

/**
 * Desktop shell: local API + HTML UI rendered in an embedded WebView.
 */
public class DesktopApp extends Application {
    private static final int DEFAULT_PORT = 7070;

    private static final String[] THEMES = {
            "teal", "ocean", "ember", "violet", "slate",
            "light", "light-ocean", "light-ember", "light-violet", "light-slate"
    };
    private static final int[] ZOOM_LEVELS = {75, 90, 100, 110, 125, 150};

    private ApiServer server;
    private WebEngine engine;

    @Override
    public void start(Stage stage) {
        // Rename macOS app menu from "java" → "DB Pilot" once the toolkit is live.
        Launcher.applyNativeAppName();

        server = new ApiServer(DEFAULT_PORT);
        server.start();

        String url = "http://127.0.0.1:" + server.getPort() + "/";
        WebView webView = new WebView();
        webView.setContextMenuEnabled(false);
        engine = webView.getEngine();

        // JavaFX WebView defaults cancel confirm/prompt — wire native dialogs.
        engine.setConfirmHandler(message -> {
            Alert alert = new Alert(Alert.AlertType.CONFIRMATION, message, ButtonType.OK, ButtonType.CANCEL);
            alert.setHeaderText(null);
            alert.initOwner(stage);
            return alert.showAndWait().orElse(ButtonType.CANCEL) == ButtonType.OK;
        });
        engine.setPromptHandler(promptData -> {
            TextInputDialog dialog = new TextInputDialog(
                    promptData.getDefaultValue() != null ? promptData.getDefaultValue() : "");
            dialog.setTitle(Launcher.APP_NAME);
            dialog.setHeaderText(null);
            dialog.setContentText(promptData.getMessage());
            dialog.initOwner(stage);
            return dialog.showAndWait().orElse(null);
        });
        engine.setOnAlert(event -> {
            Alert alert = new Alert(Alert.AlertType.INFORMATION, event.getData(), ButtonType.OK);
            alert.setHeaderText(null);
            alert.initOwner(stage);
            alert.showAndWait();
        });

        DesktopBridge bridge = new DesktopBridge(stage);
        engine.getLoadWorker().stateProperty().addListener((obs, oldState, newState) -> {
            if (newState == javafx.concurrent.Worker.State.SUCCEEDED) {
                Object window = engine.executeScript("window");
                if (window instanceof JSObject js) {
                    js.setMember("javaApp", bridge);
                }
            }
        });

        engine.load(url);

        MenuBar menuBar = buildMenuBar(stage);
        menuBar.setUseSystemMenuBar(true);

        BorderPane root = new BorderPane();
        root.setTop(menuBar);
        root.setCenter(webView);

        Scene scene = new Scene(root, 1280, 800);
        stage.setTitle("DB Pilot");
        stage.setMinWidth(960);
        stage.setMinHeight(640);
        stage.setScene(scene);

        var iconStream = DesktopApp.class.getResourceAsStream("/icons/app-icon.png");
        if (iconStream != null) {
            stage.getIcons().add(new Image(iconStream));
        }

        stage.setOnCloseRequest(e -> {
            shutdown();
            Platform.exit();
        });
        stage.show();

        System.out.println("DB Pilot (desktop) ready — UI embedded, API on " + url);
    }

    private MenuBar buildMenuBar(Stage stage) {
        MenuBar bar = new MenuBar();

        Menu file = new Menu("File");
        MenuItem newConnection = new MenuItem("New Connection…");
        newConnection.setAccelerator(new KeyCodeCombination(KeyCode.N, KeyCombination.SHORTCUT_DOWN));
        newConnection.setOnAction(e -> runUi("newConnection"));

        MenuItem openSql = new MenuItem("Open SQL…");
        openSql.setAccelerator(new KeyCodeCombination(KeyCode.O, KeyCombination.SHORTCUT_DOWN));
        openSql.setOnAction(e -> runUi("openSql"));

        MenuItem saveSql = new MenuItem("Save SQL…");
        saveSql.setAccelerator(new KeyCodeCombination(KeyCode.S, KeyCombination.SHORTCUT_DOWN));
        saveSql.setOnAction(e -> runUi("saveSql"));

        MenuItem quit = new MenuItem("Quit");
        quit.setAccelerator(new KeyCodeCombination(KeyCode.Q, KeyCombination.SHORTCUT_DOWN));
        quit.setOnAction(e -> {
            stage.fireEvent(new javafx.stage.WindowEvent(stage, javafx.stage.WindowEvent.WINDOW_CLOSE_REQUEST));
        });

        file.getItems().addAll(newConnection, openSql, saveSql, new SeparatorMenuItem(), quit);

        Menu settings = new Menu("Settings");

        Menu themeMenu = new Menu("Theme");
        ToggleGroup themeGroup = new ToggleGroup();
        for (String theme : THEMES) {
            RadioMenuItem item = new RadioMenuItem(themeLabel(theme));
            item.setToggleGroup(themeGroup);
            item.setUserData(theme);
            if ("teal".equals(theme)) {
                item.setSelected(true);
            }
            item.setOnAction(e -> runUi("setTheme", theme));
            themeMenu.getItems().add(item);
        }

        Menu zoomMenu = new Menu("Zoom");
        ToggleGroup zoomGroup = new ToggleGroup();
        for (int zoom : ZOOM_LEVELS) {
            RadioMenuItem item = new RadioMenuItem(zoom + "%");
            item.setToggleGroup(zoomGroup);
            item.setUserData(zoom);
            if (zoom == 100) {
                item.setSelected(true);
            }
            item.setOnAction(e -> runUi("setZoom", zoom));
            zoomMenu.getItems().add(item);
        }

        Menu densityMenu = new Menu("Density");
        ToggleGroup densityGroup = new ToggleGroup();
        RadioMenuItem comfortable = new RadioMenuItem("Comfortable");
        comfortable.setToggleGroup(densityGroup);
        comfortable.setOnAction(e -> runUi("setDensity", "comfortable"));
        RadioMenuItem compact = new RadioMenuItem("Compact");
        compact.setToggleGroup(densityGroup);
        compact.setSelected(true);
        compact.setOnAction(e -> runUi("setDensity", "compact"));
        densityMenu.getItems().addAll(comfortable, compact);

        settings.getItems().addAll(themeMenu, zoomMenu, densityMenu);

        bar.getMenus().addAll(file, settings);
        return bar;
    }

    private void runUi(String action) {
        runUi(action, null);
    }

    private void runUi(String action, Object arg) {
        Platform.runLater(() -> {
            if (engine == null) {
                return;
            }
            try {
                String script;
                if (arg == null) {
                    script = "window.dbPilotMenu && window.dbPilotMenu." + action + " && window.dbPilotMenu." + action + "()";
                } else if (arg instanceof Number) {
                    script = "window.dbPilotMenu && window.dbPilotMenu." + action
                            + " && window.dbPilotMenu." + action + "(" + arg + ")";
                } else {
                    script = "window.dbPilotMenu && window.dbPilotMenu." + action
                            + " && window.dbPilotMenu." + action + "(" + jsonString(String.valueOf(arg)) + ")";
                }
                engine.executeScript(script);
            } catch (Exception ignored) {
                // UI may not be ready yet.
            }
        });
    }

    private static String themeLabel(String theme) {
        if (theme == null || theme.isBlank()) {
            return "";
        }
        return switch (theme) {
            case "light" -> "Light Teal";
            case "light-ocean" -> "Light Ocean";
            case "light-ember" -> "Light Ember";
            case "light-violet" -> "Light Violet";
            case "light-slate" -> "Light Slate";
            default -> Character.toUpperCase(theme.charAt(0)) + theme.substring(1);
        };
    }

    private static String capitalize(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        return Character.toUpperCase(value.charAt(0)) + value.substring(1);
    }

    private static String jsonString(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\' -> sb.append("\\\\");
                case '"' -> sb.append("\\\"");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    @Override
    public void stop() {
        shutdown();
    }

    private void shutdown() {
        if (server != null) {
            server.stop();
            server = null;
        }
    }

    public static void main(String[] args) {
        // Also set here when DesktopApp is launched directly.
        Launcher.configureMacAppName();
        launch(args);
    }
}
