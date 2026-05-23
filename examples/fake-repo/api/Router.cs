using System;
using System.Collections.Generic;

namespace FakeRepo.Api;

/// <summary>Clean baseline — minimal correctness-focused router. No intentional bugs.</summary>
public class Router
{
    private readonly Dictionary<string, Func<HttpRequest, HttpResponse>> _routes = new();

    public void Register(string path, Func<HttpRequest, HttpResponse> handler)
    {
        if (string.IsNullOrEmpty(path))
            throw new ArgumentException("path must not be empty", nameof(path));
        if (handler is null)
            throw new ArgumentNullException(nameof(handler));
        _routes[path] = handler;
    }

    public HttpResponse Dispatch(HttpRequest request)
    {
        if (request is null)
            throw new ArgumentNullException(nameof(request));
        return _routes.TryGetValue(request.Path, out var handler)
            ? handler(request)
            : new HttpResponse { Status = 404, Body = "not found" };
    }
}

public class HttpRequest
{
    public string Path { get; set; } = "";
    public string Body { get; set; } = "";
}

public class HttpResponse
{
    public int Status { get; set; }
    public string Body { get; set; } = "";
}
