(function () {
  "use strict";

  // ---------------------------------------------------------------- helpers

  function substitute(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, function (whole, name) {
      var value = vars[name];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  function buildURL(cfg, name, vars) {
    var op = (cfg.operations || {})[name];
    if (!op || typeof op.path !== "string") { return null; }
    if (typeof cfg.baseURL !== "string" || cfg.baseURL === "") { return null; }
    var base = cfg.baseURL.replace(/\/$/, "");
    var href = base + substitute(op.path, vars);
    var query = op.query || {};
    var parts = [];
    Object.keys(query).forEach(function (key) {
      var value = substitute(query[key], vars);
      if (value !== "") {
        parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
      }
    });
    return parts.length ? href + "?" + parts.join("&") : href;
  }

  // Drops null/undefined-valued keys. The bridge refuses `undefined` outright and
  // the domain validator refuses a null where it expects a string, so an absent
  // optional must be an absent *key*.
  function compact(object) {
    var out = {};
    Object.keys(object).forEach(function (key) {
      var value = object[key];
      if (value !== null && value !== undefined) { out[key] = value; }
    });
    return out;
  }

  function fail(code, message) {
    return { ok: false, error: { code: code, message: message } };
  }

  function hostFailure(error) {
    var code = error && error.hostErrorCode ? error.hostErrorCode : "script";
    var message = error && error.message ? String(error.message) : String(error);
    return fail(code, message);
  }

  function positiveInt(value, fallback) {
    var parsed = typeof value === "number" ? Math.floor(value) : parseInt(value, 10);
    return isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  // The design's "Pagination": exactly one of a non-null nextCursor or
  // exhausted: true. `rawCount` is the count BEFORE the client-side slice, so a
  // page-number feed that over-delivers is still correctly not exhausted.
  function paginate(items, rawCount, limit, nextCursor) {
    var exhausted = rawCount < limit;
    return {
      items: items,
      nextCursor: exhausted ? null : String(nextCursor),
      exhausted: exhausted
    };
  }

  // Some sites honour a limit/page-size parameter and some ignore it. Trimming is
  // therefore configuration, not a universal truth: an engine that always trimmed
  // would silently shorten a feed whose server already paginates correctly.
  function clips(cfg, operation, items, limit) {
    var declared = (cfg.pagination || {}).clientLimit || [];
    return declared.indexOf(operation) >= 0 ? items.slice(0, limit) : items;
  }

  function chapterNumberFrom(title, cfg) {
    var spec = cfg.chapterNumber || {};
    var pattern = typeof spec.pattern === "string" ? spec.pattern : "\\d+(\\.\\d+)?";
    var matches = String(title || "").match(new RegExp(pattern, "g"));
    return matches && matches.length ? matches[matches.length - 1] : null;
  }

  async function extract(context, url, extractor, selectors) {
    context.signal.throwIfAborted();
    var script = "(" + extractor.toString() + ")(" + JSON.stringify(selectors) + ")";
    var result = await context.host.browser.extract({ url: url, script: script });
    context.signal.throwIfAborted();
    return result.value;
  }

  // ------------------------------------------------- page-side extractors
  //
  // Each runs inside the loaded page, is handed its own selector block, and
  // returns a plain value. No JSON.stringify: see the file header.

  function listingExtractor(s) {
    var seg = function (href, name) {
      var parts = (href || "").replace(/\/$/, "").split("/");
      var i = parts.indexOf(name);
      return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
    };
    var pick = function (root, selector) {
      var list = [].concat(selector || []);
      for (var i = 0; i < list.length; i++) {
        var found = root.querySelector(list[i]);
        if (found) { return found; }
      }
      return null;
    };
    return [].slice.call(document.querySelectorAll(s.item)).map(function (el) {
      var link = pick(el, s.link);
      var titleEl = pick(el, s.title) || link;
      var img = pick(el, s.image);
      var raw = img ? (img.getAttribute("src") || img.getAttribute("data-src")) : null;
      return {
        id: link ? seg(link.getAttribute("href"), s.idSegment) : null,
        title: titleEl ? titleEl.textContent.trim() : "",
        coverURL: raw ? new URL(raw, location.href).href : null
      };
    }).filter(function (x) { return x.id && x.title; });
  }

  function updateExtractor(s) {
    var seg = function (href, name) {
      var parts = (href || "").replace(/\/$/, "").split("/");
      var i = parts.indexOf(name);
      return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
    };
    var pick = function (root, selector) {
      var list = [].concat(selector || []);
      for (var i = 0; i < list.length; i++) {
        var found = root.querySelector(list[i]);
        if (found) { return found; }
      }
      return null;
    };
    return [].slice.call(document.querySelectorAll(s.item)).map(function (el) {
      var listingLink = pick(el, s.listingLink);
      var chapterLink = pick(el, s.chapterLink);
      var titleEl = pick(el, s.title);
      var img = pick(el, s.image);
      var raw = img ? (img.getAttribute("src") || img.getAttribute("data-src")) : null;
      return {
        id: listingLink ? seg(listingLink.getAttribute("href"), s.listingIdSegment) : null,
        chapterId: chapterLink
          ? seg(chapterLink.getAttribute("href"), s.chapterIdSegment) : null,
        title: titleEl ? titleEl.textContent.trim() : "",
        coverURL: raw ? new URL(raw, location.href).href : null
      };
    }).filter(function (x) { return x.id && x.chapterId && x.title; });
  }

  function detailExtractor(s) {
    var labelled = function (label) {
      return [].slice.call(document.querySelectorAll("strong")).find(function (node) {
        return node.textContent.indexOf(label) >= 0;
      });
    };
    var collect = function (root, selector) {
      var out = [];
      if (root && root.parentElement) {
        root.parentElement.querySelectorAll(selector).forEach(function (node) {
          var text = node.textContent.trim();
          if (text) { out.push(text); }
        });
      }
      return out;
    };
    var descEl = document.querySelector(s.description);
    var adultEl = labelled(s.adultLabel);
    var adult = !!(adultEl && adultEl.nextElementSibling
      && adultEl.nextElementSibling.textContent.trim().toLowerCase() === "yes");
    return {
      description: descEl ? descEl.textContent.trim() : null,
      authors: collect(labelled(s.authorLabel), s.authorLink),
      tags: collect(labelled(s.tagLabel), s.tagLink),
      adult: adult
    };
  }

  function chapterExtractor(s) {
    var seg = function (href, name) {
      var parts = (href || "").replace(/\/$/, "").split("/");
      var i = parts.indexOf(name);
      return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
    };
    var pick = function (root, selector) {
      var list = [].concat(selector || []);
      for (var i = 0; i < list.length; i++) {
        var found = root.querySelector(list[i]);
        if (found) { return found; }
      }
      return null;
    };
    return [].slice.call(document.querySelectorAll(s.item)).map(function (el) {
      var titleEl = pick(el, s.title);
      var timeEl = el.querySelector(s.date);
      return {
        id: seg(el.getAttribute("href"), s.idSegment),
        title: titleEl ? titleEl.textContent.trim() : "",
        publishedAt: timeEl ? timeEl.getAttribute("datetime") : null
      };
    }).filter(function (x) { return x.id; });
  }

  function pageExtractor(s) {
    return [].slice.call(document.querySelectorAll(s.image)).map(function (img) {
      return img.getAttribute("src") || img.getAttribute("data-src");
    }).filter(Boolean).map(function (raw) {
      return new URL(raw, location.href).href;
    });
  }

  // ------------------------------------------------------------ operations

  async function listingPage(operation, request, context, cfg, vars) {
    if (!request.page || typeof request.page !== "object") {
      return fail("invalid_request", "paged operations require a page object");
    }
    var limit = positiveInt(request.page.limit, 20);
    var style = (cfg.pagination || {}).listings === "page" ? "page" : "offset";
    var first = positiveInt((cfg.pagination || {}).firstPage, 1);
    var cursor = request.page.cursor;
    var marker = cursor === null || cursor === undefined || cursor === ""
      ? (style === "page" ? first : 0)
      : positiveInt(cursor, style === "page" ? first : 1);
    if (style === "offset" && (cursor === null || cursor === undefined || cursor === "")) {
      marker = 0;
    }

    vars.limit = limit;
    vars.offset = style === "offset" ? marker : (marker - first) * limit;
    vars.page = style === "page" ? marker : Math.floor(marker / limit) + first;

    var url = buildURL(cfg, operation, vars);
    if (!url) { return fail("unsupported", operation + " is not configured"); }

    var raw = await extract(context, url, listingExtractor, cfg.selectors.listing);
    var items = clips(cfg, operation, raw, limit).map(compact);
    var next = style === "page" ? marker + 1 : marker + limit;
    return { ok: true, value: paginate(items, raw.length, limit, next) };
  }

  async function updatePage(request, context, cfg) {
    if (!request.page || typeof request.page !== "object") {
      return fail("invalid_request", "paged operations require a page object");
    }
    var limit = positiveInt(request.page.limit, 20);
    var style = (cfg.pagination || {}).latestUpdates === "offset" ? "offset" : "page";
    var first = positiveInt((cfg.pagination || {}).firstPage, 1);
    var cursor = request.page.cursor;
    var empty = cursor === null || cursor === undefined || cursor === "";
    var marker = empty ? (style === "page" ? first : 0) : positiveInt(cursor, first);
    if (style === "offset" && empty) { marker = 0; }

    var url = buildURL(cfg, "latestUpdates", {
      limit: limit,
      offset: style === "offset" ? marker : (marker - first) * limit,
      page: style === "page" ? marker : Math.floor(marker / limit) + first
    });
    if (!url) { return fail("unsupported", "latestUpdates is not configured"); }

    var raw = await extract(context, url, updateExtractor, cfg.selectors.update);
    var items = clips(cfg, "latestUpdates", raw, limit).map(function (item) {
      return {
        chapterId: item.chapterId,
        listing: compact({ id: item.id, title: item.title, coverURL: item.coverURL })
      };
    });
    var next = style === "page" ? marker + 1 : marker + limit;
    return { ok: true, value: paginate(items, raw.length, limit, next) };
  }

  async function detail(request, context, cfg) {
    var url = buildURL(cfg, "detail", { listingId: request.listingId });
    if (!url) { return fail("unsupported", "detail is not configured"); }
    var raw = await extract(context, url, detailExtractor, cfg.selectors.detail);
    var ratings = cfg.contentRating || {};
    return { ok: true, value: compact({
      description: raw.description === null ? "" : raw.description,
      authors: raw.authors || [],
      tags: (raw.tags || []).map(function (name) { return { name: name }; }),
      contentRating: raw.adult ? (ratings.adult || null) : (ratings["default"] || null)
    }) };
  }

  async function chapters(request, context, cfg) {
    var url = buildURL(cfg, "chapters", { listingId: request.listingId });
    if (!url) { return fail("unsupported", "chapters is not configured"); }
    var raw = await extract(context, url, chapterExtractor, cfg.selectors.chapter);
    return { ok: true, value: { items: raw.map(function (item) {
      return compact({
        id: item.id,
        number: chapterNumberFrom(item.title, cfg),
        title: item.title,
        publishedAt: item.publishedAt
      });
    }) } };
  }

  async function pages(request, context, cfg) {
    var url = buildURL(cfg, "pages", { chapterId: request.chapterId });
    if (!url) { return fail("unsupported", "pages is not configured"); }
    var raw = await extract(context, url, pageExtractor, cfg.selectors.page);
    return { ok: true, value: { items: raw.map(function (href) {
      return { url: href };
    }) } };
  }

  function webURL(request, cfg) {
    var url = buildURL(cfg, "webURL", { listingId: request.listingId });
    if (!url) { return fail("unsupported", "webURL is not configured"); }
    return { ok: true, value: { url: url } };
  }

  // ------------------------------------------------------------ dispatch

  async function invoke(operation, request, context) {
    var cfg = context.source.configuration || {};
    if (!cfg.selectors) {
      return fail("invalid_request", "configuration declares no selectors");
    }
    try {
      switch (operation) {
      case "search":
        return await listingPage("search", request, context, cfg,
                                 { query: request.query });
      case "popular":
      case "newTitles":
        return await listingPage(operation, request, context, cfg, {});
      case "latestUpdates":
        return await updatePage(request, context, cfg);
      case "detail":
        return await detail(request, context, cfg);
      case "chapters":
        return await chapters(request, context, cfg);
      case "pages":
        return await pages(request, context, cfg);
      case "webURL":
        return webURL(request, cfg);
      default:
        return fail("unsupported", operation + " is not implemented by this engine");
      }
    } catch (error) {
      return hostFailure(error);
    }
  }

  registerEngine("htmlSelectorTheme", { invoke: invoke });
})();
