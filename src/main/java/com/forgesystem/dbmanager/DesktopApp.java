package com.forgesystem.dbmanager;

import com.forgesystem.dbmanager.web.ApiServer;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.scene.Scene;
import javafx.scene.image.Image;
import javafx.scene.layout.StackPane;
import javafx.scene.web.WebView;
import javafx.stage.Stage;

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
        webView.getEngine().load(url);

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
