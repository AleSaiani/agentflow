using System;
using System.Collections.Generic;
using System.Linq;

namespace FakeRepo.Api;

public class UserHandlers
{
    private readonly IUserQuery _query;

    public UserHandlers(IUserQuery query)
    {
        _query = query;
    }

    public IEnumerable<string> GetActiveUserNames()
    {
        // BUG: deferred execution — _query.GetAllUsers() may be enumerated multiple times
        // by callers; each enumeration hits the DB again
        var users = _query.GetAllUsers().Where(u => u.IsActive);
        return users.Select(u => u.Name);
    }

    public int CountActive()
    {
        var active = GetActiveUserNames();
        // BUG: double enumeration — the Where filter runs twice (once for Count, once for any
        // subsequent caller using the same returned IEnumerable)
        var count = active.Count();
        Console.WriteLine($"Found {active.Count()} active users");
        return count;
    }
}

public interface IUserQuery
{
    IEnumerable<UserRecord> GetAllUsers();
}

public class UserRecord
{
    public string Name { get; set; } = "";
    public bool IsActive { get; set; }
}
