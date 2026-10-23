/** Fixture-owned conditional extension whose factory always fails to load. */
export default function failingExtension() {
	throw new Error("Fixture extension failed to load on purpose.");
}
