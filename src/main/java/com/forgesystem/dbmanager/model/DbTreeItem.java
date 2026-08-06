package com.forgesystem.dbmanager.model;

public class DbTreeItem {
    private final String label;
    private final TreeNodeType type;
    private final String schema;
    private final String name;
    private boolean loaded;

    public DbTreeItem(String label, TreeNodeType type, String schema, String name) {
        this.label = label;
        this.type = type;
        this.schema = schema;
        this.name = name;
        this.loaded = false;
    }

    public String getLabel() {
        return label;
    }

    public TreeNodeType getType() {
        return type;
    }

    public String getSchema() {
        return schema;
    }

    public String getName() {
        return name;
    }

    public boolean isLoaded() {
        return loaded;
    }

    public void setLoaded(boolean loaded) {
        this.loaded = loaded;
    }

    @Override
    public String toString() {
        return label;
    }
}
