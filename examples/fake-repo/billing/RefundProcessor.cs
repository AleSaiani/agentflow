using System;
using System.Data.SqlClient;
using System.Threading;
using System.Threading.Tasks;

namespace FakeRepo.Billing;

public class RefundProcessor
{
    private readonly string _connectionString;

    public RefundProcessor(string connectionString)
    {
        _connectionString = connectionString;
    }

    public async Task<bool> ProcessRefundAsync(int invoiceId, decimal amount, CancellationToken ct)
    {
        // BUG: ct not propagated to OpenAsync / ExecuteScalarAsync
        var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var cmd = new SqlCommand("UPDATE invoices SET refunded = refunded + @a WHERE id = @id", conn);
        cmd.Parameters.AddWithValue("@a", amount);
        cmd.Parameters.AddWithValue("@id", invoiceId);

        // BUG: no ConfigureAwait(false); BUG: conn never disposed (leak on exception)
        var rows = await cmd.ExecuteNonQueryAsync();
        // missing conn.Dispose() / using
        return rows > 0;
    }
}
