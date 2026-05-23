using System;
using System.Collections.Generic;

namespace FakeRepo.Auth;

public class TokenIssuer
{
    private readonly Dictionary<string, DateTime> _activeTokens = new();
    private readonly object _lockA = new();
    private readonly object _lockB = new();

    public string Issue(string userId)
    {
        // BUG: inverted lock order vs Revoke() — possible deadlock under contention
        lock (_lockA)
        {
            lock (_lockB)
            {
                var token = Guid.NewGuid().ToString("N");
                _activeTokens[token] = DateTime.UtcNow.AddHours(1);
                return token;
            }
        }
    }

    public void Revoke(string token)
    {
        lock (_lockB)
        {
            lock (_lockA)
            {
                _activeTokens.Remove(token);
            }
        }
    }

    public bool IsValid(string token)
    {
        // BUG: not under lock — race with Revoke causing torn reads on the dictionary
        return _activeTokens.ContainsKey(token) && _activeTokens[token] > DateTime.UtcNow;
    }
}
