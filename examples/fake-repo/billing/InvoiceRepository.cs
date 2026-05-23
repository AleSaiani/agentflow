using System;
using System.Data;
using System.Data.SqlClient;
using System.Collections.Generic;

namespace FakeRepo.Billing;

public class InvoiceRepository
{
    private readonly string _connectionString;

    public InvoiceRepository(string connectionString)
    {
        _connectionString = connectionString;
    }

    public List<Invoice> SearchByCustomer(string customerName)
    {
        // BUG: SQL injection via string interpolation
        var sql = $"SELECT id, total FROM invoices WHERE customer_name = '{customerName}'";

        var result = new List<Invoice>();
        using var conn = new SqlConnection(_connectionString);
        conn.Open();
        using var cmd = new SqlCommand(sql, conn);
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            result.Add(new Invoice { Id = reader.GetInt32(0), Total = reader.GetDecimal(1) });
        }
        return result;
    }

    public decimal GetTotal(int invoiceId)
    {
        using var conn = new SqlConnection(_connectionString);
        conn.Open();
        using var cmd = new SqlCommand("SELECT total FROM invoices WHERE id = @id", conn);
        cmd.Parameters.AddWithValue("@id", invoiceId);
        var result = cmd.ExecuteScalar();
        // BUG: float/decimal comparison wrong — should be decimal cast
        return (decimal)(double)result;
    }
}

public class Invoice
{
    public int Id { get; set; }
    public decimal Total { get; set; }
}
