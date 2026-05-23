using System;
using System.Collections.Generic;

namespace FakeRepo.Data;

/// <summary>Clean baseline — defensive in-memory store. No intentional bugs.</summary>
public class Repository<T> where T : class
{
    private readonly Dictionary<int, T> _store = new();
    private int _nextId = 1;
    private readonly object _lock = new();

    public int Add(T entity)
    {
        if (entity is null)
            throw new ArgumentNullException(nameof(entity));
        lock (_lock)
        {
            var id = _nextId++;
            _store[id] = entity;
            return id;
        }
    }

    public T? GetById(int id)
    {
        lock (_lock)
        {
            return _store.TryGetValue(id, out var entity) ? entity : null;
        }
    }

    public IReadOnlyList<T> Snapshot()
    {
        lock (_lock)
        {
            return new List<T>(_store.Values);
        }
    }
}
