package com.forgesystem.dbmanager.model;

/** Column predicate sent from the data grid to the rows API. */
public class RowFilter {
    public String column;
    public String op;
    public String value;
}
