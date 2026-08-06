package com.forgesystem.dbmanager;

import com.forgesystem.dbmanager.web.ApiServer;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.scene.Scene;
import javafx.scene.control.Alert;
import javafx.scene.control.ButtonType;
import javafx.scene.image.Image;
import javafx.scene.layout.StackPane;
import javafx.scene.web.WebEngine;
import javafx.scene.web.WebView;
import javafx.stage.Stage;
import netscape.javascript.JSObject;

/**
 * Desktop shell: local API + HTML UI rendered in an embedded WebView.
 */
public class DesktopApp extends Application {
    private static final int DEFAULT_PORT = 7070;

    private ApiServer server;

    @Override
    public void start(Stage stage) {
        server = new ApiServer(DEFAULT_PORT);
        server.start();

        String url = "http://127.0.0.1:" + server.getPort() + "/";
        WebView webView = new WebView();
        webView.setContextMenuEnabled(false);
        WebEngine engine = webView.getEngine();

        // JavaFX WebView defaults cancel every window.confirm() — wire native dialogs.
        engine.setConfirmHandler(message -> {
            Alert alert = new Alert(Alert.AlertType.CONFIRMATION, message, ButtonType.OK, ButtonType.CANCEL);
            alert.setHeaderText(null);
            alert.initOwner(stage);
            return alert.showAndWait().orElse(ButtonType.CANCEL) == ButtonType.OK;
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

        Scene scene = new Scene(new StackPane(webView), 1280, 800);
        stage.setTitle("Forge Database Manager");
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

        System.out.println("Forge Database Manager (desktop) ready — UI embedded, API on " + url);
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
        launch(args);
    }
}
