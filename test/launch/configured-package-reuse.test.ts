import { resolveConfiguredExtensionSources } from "../../src/launch/extensions.ts";
import {
	advanceGitCheckout,
	assert,
	createGitCheckout,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	mkdirSync,
	writeFileSync,
} from "../support/index.ts";

/**
 * A configured package installation is reused for a child only when it is
 * installed as configured. Anything else falls back to the original source so
 * Pi's temporary resolution installs it, and never fails the launch.
 */
describe("configured package reuse validation", () => {
	const gitSource = "git:github.com/example/footer-extension";

	function setup(packages: string[], root: "child" | "parent" = "child") {
		const cwd = createTestDir();
		const agentDir = join(cwd, "child-root");
		const parentAgentDir = join(cwd, "parent-root");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(parentAgentDir, { recursive: true });
		const configuredRoot = root === "child" ? agentDir : parentAgentDir;
		writeFileSync(join(configuredRoot, "settings.json"), JSON.stringify({ packages }));
		return {
			cwd,
			configuredRoot,
			gitRoot: join(configuredRoot, "git", "github.com", "example", "footer-extension"),
			npmRoot: (name: string) => join(configuredRoot, "npm", "node_modules", name),
			resolve: (source: string) =>
				resolveConfiguredExtensionSources([source], {
					cwd,
					agentDir,
					parentAgentDir,
					agentDefs: null,
					mode: "background",
				}),
		};
	}

	for (const root of ["child", "parent"] as const) {
		it(`reuses a ${root}-root Git checkout whose HEAD is at the configured ref`, () => {
			const source = `${gitSource}@v1`;
			const env = setup([source], root);
			createGitCheckout(env.gitRoot);
			assert.deepEqual(env.resolve(source), [env.gitRoot]);
		});

		it(`falls back when a ${root}-root Git checkout HEAD differs from the configured ref`, () => {
			const source = `${gitSource}@v1`;
			const env = setup([source], root);
			createGitCheckout(env.gitRoot);
			advanceGitCheckout(env.gitRoot);
			assert.deepEqual(env.resolve(source), [source]);
		});
	}

	for (const source of [
		"git:git@github.com:example/footer-extension@v1",
		"ssh://git@github.com/example/footer-extension@v1",
		"https://github.com/example/footer-extension#v1",
	]) {
		it(`reads the ref of ${source}`, () => {
			const env = setup([source]);
			createGitCheckout(env.gitRoot);
			assert.deepEqual(env.resolve(source), [env.gitRoot]);
			advanceGitCheckout(env.gitRoot);
			assert.deepEqual(env.resolve(source), [source]);
		});
	}

	it("reuses a Git checkout pinned to the commit sha HEAD is at", () => {
		const env = setup([]);
		const sha = createGitCheckout(env.gitRoot);
		const source = `${gitSource}@${sha}`;
		writeFileSync(join(env.configuredRoot, "settings.json"), JSON.stringify({ packages: [source] }));
		assert.deepEqual(env.resolve(source), [env.gitRoot]);
	});

	it("falls back when the configured ref does not resolve in the checkout", () => {
		const source = `${gitSource}@v9`;
		const env = setup([source]);
		createGitCheckout(env.gitRoot);
		assert.deepEqual(env.resolve(source), [source]);
	});

	it("falls back when git cannot run", () => {
		const source = `${gitSource}@v1`;
		const env = setup([source]);
		createGitCheckout(env.gitRoot);
		const path = process.env.PATH;
		process.env.PATH = "";
		try {
			assert.deepEqual(env.resolve(source), [source]);
		} finally {
			process.env.PATH = path;
		}
	});

	it("does not run a git executable planted in the install directory", () => {
		const source = `${gitSource}@v1`;
		const env = setup([source]);
		createGitCheckout(env.gitRoot);
		const marker = join(env.cwd, "planted-git-ran");
		writeFileSync(join(env.gitRoot, "git"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
		const path = process.env.PATH;
		process.env.PATH = `:${path}`;
		try {
			assert.deepEqual(env.resolve(source), [env.gitRoot]);
		} finally {
			process.env.PATH = path;
		}
		assert.equal(existsSync(marker), false);
	});

	it("ignores inherited GIT_* variables that point at another repository", () => {
		const source = `${gitSource}@v1`;
		const env = setup([source]);
		createGitCheckout(env.gitRoot);
		const other = join(env.cwd, "other-repo");
		createGitCheckout(other);
		advanceGitCheckout(other);
		const gitDir = process.env.GIT_DIR;
		process.env.GIT_DIR = join(other, ".git");
		try {
			assert.deepEqual(env.resolve(source), [env.gitRoot]);
		} finally {
			if (gitDir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = gitDir;
		}
	});

	it("reuses an unpinned Git install only when it is a Git checkout", () => {
		const env = setup([gitSource]);
		mkdirSync(env.gitRoot, { recursive: true });
		writeFileSync(join(env.gitRoot, "package.json"), JSON.stringify({ name: "footer-extension" }));
		assert.deepEqual(env.resolve(gitSource), [gitSource]);

		const checkout = setup([gitSource]);
		createGitCheckout(checkout.gitRoot);
		assert.deepEqual(checkout.resolve(gitSource), [checkout.gitRoot]);
	});

	it("does not take an enclosing repository for the install's checkout", () => {
		const source = `${gitSource}@v1`;
		const env = setup([source]);
		createGitCheckout(env.cwd);
		mkdirSync(env.gitRoot, { recursive: true });
		assert.deepEqual(env.resolve(source), [source]);
		assert.deepEqual(env.resolve(gitSource), [gitSource]);
	});

	it("reuses an npm install whose package.json names the requested package", () => {
		const source = "npm:pi-fancy-footer";
		const env = setup([source]);
		mkdirSync(env.npmRoot("pi-fancy-footer"), { recursive: true });
		writeFileSync(join(env.npmRoot("pi-fancy-footer"), "package.json"), JSON.stringify({ name: "pi-fancy-footer" }));
		assert.deepEqual(env.resolve(source), [env.npmRoot("pi-fancy-footer")]);
	});

	it("reuses an npm install whose package.json starts with a byte order mark", () => {
		const source = "npm:pi-fancy-footer";
		const env = setup([source]);
		mkdirSync(env.npmRoot("pi-fancy-footer"), { recursive: true });
		writeFileSync(
			join(env.npmRoot("pi-fancy-footer"), "package.json"),
			`\uFEFF${JSON.stringify({ name: "pi-fancy-footer" })}`,
		);
		assert.deepEqual(env.resolve(source), [env.npmRoot("pi-fancy-footer")]);
	});

	for (const [label, packageJson] of [
		["is missing", undefined],
		["does not parse", "{ not json"],
		["names another package", JSON.stringify({ name: "other-footer" })],
	] as const) {
		it(`falls back when the npm install's package.json ${label}`, () => {
			const source = "npm:pi-fancy-footer";
			const env = setup([source]);
			mkdirSync(env.npmRoot("pi-fancy-footer"), { recursive: true });
			if (packageJson !== undefined) writeFileSync(join(env.npmRoot("pi-fancy-footer"), "package.json"), packageJson);
			assert.deepEqual(env.resolve(source), [source]);
		});
	}
});
