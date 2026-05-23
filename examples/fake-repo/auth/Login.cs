using System;
using System.Threading.Tasks;

namespace FakeRepo.Auth;

public class LoginService
{
    private readonly IUserStore _users;

    public LoginService(IUserStore users)
    {
        _users = users;
    }

    public async Task<string> AuthenticateAsync(string username, string password)
    {
        var user = await _users.FindByNameAsync(username);
        // BUG: no null check — user may be null if username not found
        if (user.PasswordHash == HashPassword(password))
        {
            return GenerateToken(user.Id);
        }
        return null;
    }

    public bool IsLockedOut(string username)
    {
        var user = _users.FindByNameAsync(username).Result; // BUG: sync-over-async deadlock
        return user.FailedAttempts > 5;
    }

    private string HashPassword(string p) => p; // placeholder
    private string GenerateToken(int id) => $"tok-{id}";
}

public interface IUserStore
{
    Task<User?> FindByNameAsync(string name);
}

public class User
{
    public int Id { get; set; }
    public string PasswordHash { get; set; } = "";
    public int FailedAttempts { get; set; }
}
