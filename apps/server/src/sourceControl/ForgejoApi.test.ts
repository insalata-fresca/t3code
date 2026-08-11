import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ForgejoApi from "./ForgejoApi.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";

const forgejoPullRequest = {
  number: 42,
  title: "Add Forgejo provider",
  state: "open",
  merged: false,
  updated_at: "2026-01-02T00:00:00.000Z",
  html_url: "https://forgejo.test.local/pingdotgg/t3code/pulls/42",
  head: {
    ref: "feature/source-control",
    repo: {
      full_name: "octocat/t3code",
      owner: { login: "octocat" },
    },
  },
  base: {
    ref: "main",
    repo: {
      full_name: "pingdotgg/t3code",
      owner: { login: "pingdotgg" },
    },
  },
};

const repositoryJson = {
  full_name: "pingdotgg/t3code",
  html_url: "https://forgejo.test.local/pingdotgg/t3code",
  clone_url: "https://forgejo.test.local/pingdotgg/t3code.git",
  ssh_url: "git@forgejo.test.local:pingdotgg/t3code.git",
  default_branch: "main",
};

function makeLayer(input: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly env?: Record<string, string>;
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );
  const gitMock = {
    readConfigValue: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"]>(() =>
      Effect.succeed<string | null>("git@forgejo.test.local:pingdotgg/t3code.git"),
    ),
    resolvePrimaryRemoteName: vi.fn<
      GitVcsDriver.GitVcsDriver["Service"]["resolvePrimaryRemoteName"]
    >(() => Effect.succeed("origin")),
    ensureRemote: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"]>(() =>
      Effect.succeed("octocat"),
    ),
    fetchRemoteBranch: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"]>(
      () => Effect.void,
    ),
    fetchRemoteTrackingBranch: vi.fn<
      GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]
    >(() => Effect.void),
    setBranchUpstream: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"]>(
      () => Effect.void,
    ),
    switchRef: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["switchRef"]>((request) =>
      Effect.succeed({ refName: request.refName }),
    ),
    listLocalBranchNames: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"]>(() =>
      Effect.succeed([]),
    ),
  };
  const git = {
    ...gitMock,
    ...input.git,
  } satisfies Partial<GitVcsDriver.GitVcsDriver["Service"]>;

  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: [
          {
            name: "origin",
            url: "git@forgejo.test.local:pingdotgg/t3code.git",
            pushUrl: Option.none(),
            isPrimary: true,
          },
        ],
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  const layer = ForgejoApi.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () =>
          Effect.succeed({
            kind: "git",
            repository: {
              kind: "git",
              rootPath: "/repo",
              metadataPath: null,
              freshness: {
                source: "live-local" as const,
                observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
                expiresAt: Option.none(),
              },
            },
            driver: driver as unknown as VcsDriver.VcsDriver["Service"],
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: input.env ?? {
            T3CODE_FORGEJO_API_BASE_URL: "https://forgejo.test.local/api/v1",
            T3CODE_FORGEJO_API_TOKEN: "forgejo-token",
          },
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return { execute, git: gitMock, layer };
}

it.effect("parses pull request responses from the Forgejo REST API", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        ...forgejoPullRequest,
      }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const result = yield* forgejo.getPullRequest({
      cwd: "/repo",
      reference: "#42",
    });

    assert.deepStrictEqual(result, {
      number: 42,
      title: "Add Forgejo provider",
      url: "https://forgejo.test.local/pingdotgg/t3code/pulls/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "octocat/t3code",
      headRepositoryOwnerLogin: "octocat",
    });
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://forgejo.test.local/api/v1/repos/pingdotgg/t3code/pulls/42",
    );
    assert.strictEqual(request?.headers.authorization, "token forgejo-token");
  }).pipe(Effect.provide(layer));
});

it.effect("lists pull requests with Forgejo state and limit query params", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json([
        forgejoPullRequest,
        {
          ...forgejoPullRequest,
          number: 7,
          head: {
            ref: "feature/other",
            repo: { full_name: "pingdotgg/t3code" },
          },
        },
      ]),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const result = yield* forgejo.listPullRequests({
      cwd: "/repo",
      headSelector: "origin:feature/source-control",
      state: "open",
      limit: 10,
    });

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.number, 42);
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://forgejo.test.local/api/v1/repos/pingdotgg/t3code/pulls",
    );
    assert.deepStrictEqual(request?.urlParams.params, [
      ["state", "open"],
      ["limit", "10"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("separates merged pull requests from the closed Forgejo list", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json([
        {
          ...forgejoPullRequest,
          number: 8,
          state: "closed",
          merged: true,
        },
        {
          ...forgejoPullRequest,
          number: 9,
          state: "closed",
          merged: false,
        },
      ]),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const result = yield* forgejo.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/source-control",
      state: "merged",
      limit: 10,
    });

    assert.deepStrictEqual(
      result.map((record) => record.number),
      [8],
    );
    assert.deepStrictEqual(execute.mock.calls[0]?.[0].urlParams.params, [
      ["state", "closed"],
      ["limit", "10"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("reads repository clone URLs and default branch", () => {
  const { layer } = makeLayer({
    response: () => Response.json(repositoryJson),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const cloneUrls = yield* forgejo.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: "pingdotgg/t3code",
    });
    const defaultBranch = yield* forgejo.getDefaultBranch({ cwd: "/repo" });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "pingdotgg/t3code",
      url: "https://forgejo.test.local/pingdotgg/t3code.git",
      sshUrl: "git@forgejo.test.local:pingdotgg/t3code.git",
    });
    assert.strictEqual(defaultBranch, "main");
  }).pipe(Effect.provide(layer));
});

it.effect("creates personal repositories through the Forgejo /user/repos route", () => {
  const { execute, layer } = makeLayer({
    response: (request) =>
      request.method === "GET"
        ? Response.json({ login: "pingdotgg" })
        : Response.json(repositoryJson),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const cloneUrls = yield* forgejo.createRepository({
      cwd: "/repo",
      repository: "pingdotgg/t3code",
      visibility: "private",
    });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "pingdotgg/t3code",
      url: "https://forgejo.test.local/pingdotgg/t3code.git",
      sshUrl: "git@forgejo.test.local:pingdotgg/t3code.git",
    });

    assert.strictEqual(execute.mock.calls[0]?.[0].url, "https://forgejo.test.local/api/v1/user");
    const request = execute.mock.calls[1]?.[0];
    assert.strictEqual(request?.url, "https://forgejo.test.local/api/v1/user/repos");
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    const rawBody = (request.body as { readonly body?: Uint8Array }).body;
    assert.ok(rawBody);
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(rawBody)), {
      name: "t3code",
      private: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("creates organization repositories through the Forgejo org route", () => {
  const { execute, layer } = makeLayer({
    response: (request) =>
      request.method === "GET"
        ? Response.json({ login: "pingdotgg" })
        : Response.json({ ...repositoryJson, full_name: "acme/t3code" }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.createRepository({
      cwd: "/repo",
      repository: "acme/t3code",
      visibility: "public",
    });

    const request = execute.mock.calls[1]?.[0];
    assert.strictEqual(request?.url, "https://forgejo.test.local/api/v1/orgs/acme/repos");
    assert.strictEqual(request?.method, "POST");
  }).pipe(Effect.provide(layer));
});

it.effect("creates pull requests using the official REST payload shape", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(forgejoPullRequest),
  });

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "forgejo-pr-body-" });
    yield* fileSystem.writeFileString(bodyFile, "PR body");

    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile,
    });

    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://forgejo.test.local/api/v1/repos/pingdotgg/t3code/pulls",
    );
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    const rawBody = (request.body as { readonly body?: Uint8Array }).body;
    assert.ok(rawBody);
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(rawBody)), {
      title: "Provider PR",
      body: "PR body",
      head: "owner:feature/provider",
      base: "main",
    });
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("reports auth status through the Forgejo REST /user endpoint", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ login: "forgejo-user" }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const auth = yield* forgejo.probeAuth;

    assert.deepStrictEqual(auth, {
      status: "authenticated",
      account: Option.some("forgejo-user"),
      host: Option.some("forgejo.test.local"),
      detail: Option.none(),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("reports unauthenticated when the Forgejo environment is not configured", () => {
  const { layer } = makeLayer({
    response: () => Response.json({}),
    env: {},
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const auth = yield* forgejo.probeAuth;
    const error = yield* Effect.flip(
      forgejo.getPullRequest({
        cwd: "/repo",
        reference: "42",
      }),
    );

    assert.deepStrictEqual(auth, {
      status: "unauthenticated",
      account: Option.none(),
      host: Option.none(),
      detail: Option.some("Set T3CODE_FORGEJO_API_BASE_URL and T3CODE_FORGEJO_API_TOKEN."),
    });
    assert.instanceOf(error, ForgejoApi.ForgejoConfigurationError);
    assert.strictEqual(
      error.message,
      "Forgejo API failed in getPullRequest: T3CODE_FORGEJO_API_BASE_URL is not configured.",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("keeps Forgejo response bodies out of error diagnostics", () => {
  const responseBody = '{"message":"credential=secret-value"}';
  const { layer } = makeLayer({
    response: () => new Response(responseBody, { status: 403 }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const error = yield* forgejo
      .getPullRequest({ cwd: "/repo", reference: "42" })
      .pipe(Effect.flip);

    assert.instanceOf(error, ForgejoApi.ForgejoResponseError);
    assert.strictEqual(error.operation, "getPullRequest");
    assert.strictEqual(error.status, 403);
    assert.strictEqual(error.responseBodyLength, responseBody.length);
    assert.notProperty(error, "responseBody");
    assert.strictEqual(
      error.message,
      "Forgejo API failed in getPullRequest: Forgejo returned HTTP 403.",
    );
    assert.notInclude(error.message, "secret-value");
  }).pipe(Effect.provide(layer));
});

it.effect("fails decoding when Forgejo returns an unexpected resource shape", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ unexpected: true }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const error = yield* forgejo
      .getPullRequest({ cwd: "/repo", reference: "42" })
      .pipe(Effect.flip);

    assert.instanceOf(error, ForgejoApi.ForgejoResponseDecodeError);
    assert.strictEqual(error.operation, "getPullRequest");
    assert.strictEqual(error.status, 200);
    assert.strictEqual(
      error.message,
      "Forgejo API failed in getPullRequest: Forgejo returned invalid JSON for the requested resource.",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("checks out same-repository pull requests with the existing Forgejo remote", () => {
  const { git, layer } = makeLayer({
    response: () =>
      Response.json({
        ...forgejoPullRequest,
        head: {
          ref: "feature/source-control",
          repo: {
            full_name: "pingdotgg/t3code",
            owner: { login: "pingdotgg" },
          },
        },
      }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.checkoutPullRequest({
      cwd: "/repo",
      context: {
        provider: {
          kind: "forgejo",
          name: "Forgejo Self-Hosted",
          baseUrl: "https://forgejo.test.local",
        },
        remoteName: "origin",
        remoteUrl: "git@forgejo.test.local:pingdotgg/t3code.git",
      },
      reference: "42",
      force: true,
    });

    assert.strictEqual(git.ensureRemote.mock.calls.length, 0);
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "origin",
      remoteBranch: "feature/source-control",
      localBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "feature/source-control",
      remoteName: "origin",
      remoteBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "feature/source-control",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("checks out fork pull requests through an ensured fork remote", () => {
  const { git, layer } = makeLayer({
    response: (request) => {
      if (request.url.endsWith("/repos/octocat/t3code")) {
        return Response.json({
          ...repositoryJson,
          full_name: "octocat/t3code",
          html_url: "https://forgejo.test.local/octocat/t3code",
          clone_url: "https://forgejo.test.local/octocat/t3code.git",
          ssh_url: "git@forgejo.test.local:octocat/t3code.git",
        });
      }
      return Response.json({
        ...forgejoPullRequest,
        head: {
          ref: "main",
          repo: {
            full_name: "octocat/t3code",
            owner: { login: "octocat" },
          },
        },
      });
    },
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.checkoutPullRequest({
      cwd: "/repo",
      reference: "42",
      force: true,
    });

    assert.deepStrictEqual(git.ensureRemote.mock.calls[0]?.[0], {
      cwd: "/repo",
      preferredName: "octocat",
      url: "git@forgejo.test.local:octocat/t3code.git",
    });
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "octocat",
      remoteBranch: "main",
      localBranch: "t3code/pr-42/main",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "t3code/pr-42/main",
      remoteName: "octocat",
      remoteBranch: "main",
    });
    assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "t3code/pr-42/main",
    });
  }).pipe(Effect.provide(layer));
});
