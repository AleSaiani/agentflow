using System;
using System.Collections.Generic;

namespace FakeRepo.Data;

public class MigrationRunner
{
    private readonly List<IMigration> _migrations;

    public MigrationRunner(List<IMigration> migrations)
    {
        _migrations = migrations;
    }

    public void RunPending(int lastAppliedVersion)
    {
        // BUG: off-by-one — should be `i < _migrations.Count`, not `i <= _migrations.Count`
        for (int i = lastAppliedVersion; i <= _migrations.Count; i++)
        {
            _migrations[i].Up();
        }
    }

    public void Rollback(int targetVersion)
    {
        // BUG: swallowed exception — failures are silently ignored, leaving DB in unknown state
        try
        {
            for (int i = _migrations.Count - 1; i > targetVersion; i--)
            {
                _migrations[i].Down();
            }
        }
        catch
        {
            // silently continue
        }
    }
}

public interface IMigration
{
    void Up();
    void Down();
}
