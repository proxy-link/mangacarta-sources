(function () {
  "use strict";

  function fail(code, message, retryAfterSeconds) {
    var error = { code: code, message: message };
    if (typeof retryAfterSeconds === "number") { error.retryAfterSeconds = retryAfterSeconds; }
    return { ok: false, error: error };
  }

  var DEFAULT_LIMIT = 20;
  var MAX_LIMIT = 100;          // /manga and /chapter reject limit > 100
  var OFFSET_WINDOW = 10000;    // MangaDex rejects offset + limit > 10000

  function hostError(code, message, retryAfterSeconds) {
    return { hostErrorCode: code, message: message, retryAfterSeconds: retryAfterSeconds };
  }

  function hostFailure(error) {
    var code = error && error.hostErrorCode ? error.hostErrorCode : "script";
    var message = error && error.message ? String(error.message) : String(error);
    return fail(code, message, error ? error.retryAfterSeconds : undefined);
  }

  // Drops null/undefined keys: the bridge refuses `undefined`, and the validator
  // refuses a null where it expects a string. An absent optional is an absent key.
  function compact(object) {
    var out = {};
    Object.keys(object).forEach(function (key) {
      if (object[key] !== null && object[key] !== undefined) { out[key] = object[key]; }
    });
    return out;
  }

  function queryString(pairs) {
    return pairs.filter(function (pair) {
      return pair[1] !== null && pair[1] !== undefined && pair[1] !== "";
    }).map(function (pair) {
      return encodeURIComponent(pair[0]) + "=" + encodeURIComponent(String(pair[1]));
    }).join("&");
  }

  // Statuses come back as values (Host API §4.1); this is where site semantics live.
  // 404 is "not found", which callers decide how to report.
  async function getJSON(context, cfg, path, pairs) {
    var query = queryString(pairs || []);
    var response = await context.host.http.request({
      url: cfg.apiBaseURL + path + (query ? "?" + query : ""),
      responseType: "text"
    });
    if (response.status === 404) { return null; }
    if (response.status === 429) {
      throw hostError("rate_limited", "MangaDex rate limit", response.retryAfterSeconds);
    }
    if (response.status < 200 || response.status >= 300) {
      throw hostError("http", "MangaDex answered HTTP " + response.status);
    }
    try {
      return JSON.parse(response.body);
    } catch (parseError) {
      throw hostError("script", "MangaDex response was not JSON");
    }
  }

  function offsetFrom(cursor) {
    if (cursor === null || cursor === undefined || cursor === "") { return 0; }
    var parsed = parseInt(cursor, 10);
    if (!isFinite(parsed) || parsed < 0 || String(parsed) !== String(cursor)) {
      throw hostError("invalid_request", "cursor is not an offset this engine issued");
    }
    return parsed;
  }

  function listLimit(page) {
    var parsed = typeof page.limit === "number" ? Math.floor(page.limit) : DEFAULT_LIMIT;
    return Math.max(1, Math.min(parsed, MAX_LIMIT));
  }

  // Host API §3.1: exactly one of a non-null nextCursor or exhausted: true.
  // `rawCount` is what MangaDex returned before any engine-side filtering.
  function pageResult(items, offset, limit, rawCount, total) {
    var next = offset + limit;
    var exhausted = rawCount < limit || next >= total || next + limit > OFFSET_WINDOW;
    return { items: items, nextCursor: exhausted ? null : String(next), exhausted: exhausted };
  }

  function requirePage(request) {
    if (!request.page || typeof request.page !== "object") {
      throw hostError("invalid_request", "paged operations require a page object");
    }
    return request.page;
  }

  function pickTitle(attributes) {
    var titles = attributes.title || {};
    if (typeof titles.en === "string" && titles.en.trim() !== "") { return titles.en; }
    var keys = Object.keys(titles);
    for (var i = 0; i < keys.length; i++) {
      if (typeof titles[keys[i]] === "string" && titles[keys[i]].trim() !== "") { return titles[keys[i]]; }
    }
    return "Unknown";
  }

  function alternateTitles(attributes, title) {
    var seen = {};
    seen[title] = true;
    var out = [];
    (attributes.altTitles || []).forEach(function (localized) {
      Object.keys(localized || {}).forEach(function (key) {
        var value = typeof localized[key] === "string" ? localized[key].trim() : "";
        if (value !== "" && !seen[value]) { seen[value] = true; out.push(value); }
      });
    });
    return out.length ? out : null;
  }

  // `links` is copied verbatim; the host validates `mal` and drops a slug with a warning.
  function externalIds(links) {
    var out = {};
    var any = false;
    Object.keys(links || {}).forEach(function (key) {
      if (typeof links[key] === "string" && links[key] !== "") { out[key] = links[key]; any = true; }
    });
    return any ? out : null;
  }

  function coverURL(item, cfg) {
    var art = (item.relationships || []).filter(function (rel) {
      return rel.type === "cover_art" && rel.attributes && typeof rel.attributes.fileName === "string";
    })[0];
    if (!art) { return null; }
    return cfg.coverBaseURL + "/covers/" + item.id + "/" + art.attributes.fileName + ".512.jpg";
  }

  function toListing(item, cfg) {
    var attributes = item.attributes || {};
    var title = pickTitle(attributes);
    return compact({
      id: item.id,
      title: title,
      description: attributes.description ? attributes.description.en : null,
      coverURL: coverURL(item, cfg),
      status: attributes.status,
      year: typeof attributes.year === "number" ? attributes.year : null,
      externalIds: externalIds(attributes.links),
      alternateTitles: alternateTitles(attributes, title),
      contentRating: attributes.contentRating
    });
  }

  async function mangaPage(request, context, cfg, pairs) {
    var page = requirePage(request);
    var limit = listLimit(page);
    var offset = offsetFrom(page.cursor);
    if (offset + limit > OFFSET_WINDOW) {
      return { ok: true, value: { items: [], nextCursor: null, exhausted: true } };
    }
    var body = await getJSON(context, cfg, "/manga", pairs.concat([
      ["includes[]", "cover_art"], ["limit", limit], ["offset", offset]
    ]));
    var data = (body && body.data) || [];
    var total = body && typeof body.total === "number" ? body.total : offset + data.length;
    return { ok: true, value: pageResult(data.map(function (item) { return toListing(item, cfg); }),
                                         offset, limit, data.length, total) };
  }

  async function updatesPage(request, context, cfg) {
    var page = requirePage(request);
    var titles = listLimit(page);
    var chapterLimit = Math.min(MAX_LIMIT, titles * 2);
    var offset = offsetFrom(page.cursor);
    if (offset + chapterLimit > OFFSET_WINDOW) {
      return { ok: true, value: { items: [], nextCursor: null, exhausted: true } };
    }
    var chapters = await getJSON(context, cfg, "/chapter", [
      ["includes[]", "manga"], ["translatedLanguage[]", request.language || "en"],
      ["order[readableAt]", "desc"], ["limit", chapterLimit], ["offset", offset]
    ]);
    var rows = (chapters && chapters.data) || [];
    var order = [];
    var newest = {};
    var consumed = 0;
    for (var i = 0; i < rows.length && order.length < titles; i++) {
      var chapter = rows[i];
      consumed++;
      var manga = (chapter.relationships || []).filter(function (rel) { return rel.type === "manga"; })[0];
      if (!manga || newest[manga.id]) { continue; }
      newest[manga.id] = chapter.id;
      order.push(manga.id);
    }
    var byId = {};
    if (order.length) {
      var pairs = [["includes[]", "cover_art"]];
      order.forEach(function (id) { pairs.push(["ids[]", id]); });
      pairs.push(["limit", order.length]);
      var manga = await getJSON(context, cfg, "/manga", pairs);
      ((manga && manga.data) || []).forEach(function (item) { byId[item.id] = item; });
    }
    // MangaDex returns ids[] results in its own order; the feed's order is the chapters'.
    var items = order.filter(function (id) { return byId[id]; }).map(function (id) {
      return { chapterId: newest[id], listing: toListing(byId[id], cfg) };
    });
    var total = chapters && typeof chapters.total === "number" ? chapters.total : offset + rows.length;
    // A fetched chapter beyond the title quota has not been returned. Start the next page
    // at the first unconsumed chapter rather than skipping the rest of this response.
    var next = offset + consumed;
    var exhausted = consumed === 0 || next >= total ||
      (consumed === rows.length && rows.length < chapterLimit) || next + chapterLimit > OFFSET_WINDOW;
    return { ok: true, value: { items: items, nextCursor: exhausted ? null : String(next),
                                exhausted: exhausted } };
  }

  async function tagPage(request, context, cfg) {
    var page = requirePage(request);
    var tags = await getJSON(context, cfg, "/manga/tag", []);
    var wanted = String(request.tag || "").toLowerCase();
    var match = ((tags && tags.data) || []).filter(function (tag) {
      var name = tag.attributes && tag.attributes.name ? tag.attributes.name.en : null;
      return typeof name === "string" && name.toLowerCase() === wanted;
    })[0];
    if (!match) { return { ok: true, value: { items: [], nextCursor: null, exhausted: true } }; }
    return await mangaPage(request, context, cfg, [["includedTags[]", match.id], ["order[rating]", "desc"]]);
  }

  var MAX_CHAPTERS = 2000;      // the compiled Source's safety cap

  function groupsOf(chapter) {
    var names = [];
    (chapter.relationships || []).forEach(function (rel) {
      if (rel.type !== "scanlation_group" || !rel.attributes) { return; }
      var name = typeof rel.attributes.name === "string" ? rel.attributes.name.trim() : "";
      if (name !== "" && names.indexOf(name) < 0 && names.length < 10) { names.push(name); }
    });
    return names.length ? names : null;
  }

  function toChapter(chapter) {
    var attributes = chapter.attributes || {};
    return compact({
      id: chapter.id,
      number: attributes.chapter,
      title: attributes.title,
      publishedAt: attributes.publishAt || attributes.readableAt,
      language: attributes.translatedLanguage,
      groups: groupsOf(chapter)
    });
  }

  async function chapters(request, context, cfg) {
    var raw = [];
    var offset = 0;
    while (offset < MAX_CHAPTERS) {
      var body = await getJSON(context, cfg, "/chapter", [
        ["manga", request.listingId], ["translatedLanguage[]", request.language || "en"],
        ["order[chapter]", "asc"], ["includes[]", "scanlation_group"],
        ["limit", MAX_LIMIT], ["offset", offset]
      ]);
      if (!body) { return fail("http", "MangaDex has no such manga"); }
      var data = body.data || [];
      raw = raw.concat(data);
      offset += MAX_LIMIT;
      if (data.length === 0 || offset >= body.total) { break; }
    }
    // Several groups often upload the same number; keep the first. Unknown numbers
    // are never merged. Same rule as MangaDexAPI.fetchChapters.
    var seen = {};
    var items = raw.map(toChapter).filter(function (chapter) {
      if (chapter.number === undefined) { return true; }
      if (seen[chapter.number]) { return false; }
      seen[chapter.number] = true;
      return true;
    });
    return { ok: true, value: { items: items } };
  }

  async function detail(request, context, cfg) {
    var body = await getJSON(context, cfg, "/manga/" + encodeURIComponent(request.listingId),
                             [["includes[]", "author"], ["includes[]", "artist"]]);
    if (!body || !body.data) { return fail("http", "MangaDex has no such manga"); }
    var attributes = body.data.attributes || {};
    var authors = [];
    (body.data.relationships || []).forEach(function (rel) {
      if ((rel.type === "author" || rel.type === "artist") && rel.attributes &&
          typeof rel.attributes.name === "string" && authors.indexOf(rel.attributes.name) < 0) {
        authors.push(rel.attributes.name);
      }
    });
    var tags = (attributes.tags || []).map(function (tag) {
      var tagAttributes = tag.attributes || {};
      return compact({ id: tag.id, name: (tagAttributes.name || {}).en, group: tagAttributes.group });
    }).filter(function (tag) { return typeof tag.name === "string"; });
    return { ok: true, value: compact({
      description: attributes.description ? (attributes.description.en || "") : "",
      authors: authors,
      tags: tags,
      contentRating: attributes.contentRating
    }) };
  }

  async function listing(request, context, cfg) {
    var body = await getJSON(context, cfg, "/manga/" + encodeURIComponent(request.listingId),
                             [["includes[]", "cover_art"]]);
    if (!body || !body.data) { return { ok: true, value: null }; }
    return { ok: true, value: toListing(body.data, cfg) };
  }

  function webURL(request, cfg) {
    return { ok: true, value: { url: cfg.siteBaseURL + "/title/" + encodeURIComponent(request.listingId) } };
  }

  async function pages(request, context, cfg) {
    var body = await getJSON(context, cfg, "/at-home/server/" + encodeURIComponent(request.chapterId), []);
    if (!body || !body.chapter || typeof body.baseUrl !== "string") {
      return fail("http", "MangaDex has no such chapter");
    }
    var saver = request.quality === "dataSaver";
    var files = (saver ? body.chapter.dataSaver : body.chapter.data) || [];
    var mode = saver ? "data-saver" : "data";
    return { ok: true, value: { items: files.map(function (file) {
      return { url: body.baseUrl + "/" + mode + "/" + body.chapter.hash + "/" + file };
    }) } };
  }

  async function invoke(operation, request, context) {
    var cfg = context.source.configuration || {};
    try {
      switch (operation) {
      case "search":
        return await mangaPage(request, context, cfg, [["title", request.query]]);
      case "popular":
        return await mangaPage(request, context, cfg, [["order[rating]", "desc"]]);
      case "newTitles":
        return await mangaPage(request, context, cfg, [["order[createdAt]", "desc"]]);
      case "latestUpdates":
        return await updatesPage(request, context, cfg);
      case "tagBrowse":
        return await tagPage(request, context, cfg);
      case "chapters":
        return await chapters(request, context, cfg);
      case "detail":
        return await detail(request, context, cfg);
      case "listing":
        return await listing(request, context, cfg);
      case "webURL":
        return webURL(request, cfg);
      case "pages":
        return await pages(request, context, cfg);
      default:
        return fail("unsupported", operation + " is not implemented by this engine");
      }
    } catch (error) {
      return hostFailure(error);
    }
  }

  registerEngine("mangadexApi", { invoke: invoke });
})();
