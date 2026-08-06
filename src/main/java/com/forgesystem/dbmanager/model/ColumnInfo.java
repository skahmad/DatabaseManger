package com.forgesystem.dbmanager.model;

public class ColumnInfo {
    private final String name;
    private final String typeName;
    private final int size;
    private final boolean nullable;
    private final boolean primaryKey;
    private final boolean autoIncrement;
    private final String defaultValue;

    public ColumnInfo(String name, String typeName, int size, boolean nullable,
                      boolean primaryKey, boolean autoIncrement, String defaultValue) {
        this.name = name;
        this.typeName = typeName;
        this.size = size;
        this.nullable = nullable;
        this.primaryKey = primaryKey;
        this.autoIncrement = autoIncrement;
        this.defaultValue = defaultValue;
    }

    public String getName() {
        return name;
    }

    public String getTypeName() {
        return typeName;
    }

    public int getSize() {
        return size;
    }

    public boolean isNullable() {
        return nullable;
    }

    public boolean isPrimaryKey() {
        return primaryKey;
    }

    public boolean isAutoIncrement() {
        return autoIncrement;
    }

    public String getDefaultValue() {
        return defaultValue;
    }

    public String getDisplayType() {
        if (size > 0 && !typeName.toUpperCase().contains("(")) {
            return typeName + "(" + size + ")";
        }
        return typeName;
    }
}
