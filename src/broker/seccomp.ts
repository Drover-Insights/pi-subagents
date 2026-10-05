/**
 * Classic-BPF seccomp filter that bubblewrap loads with `--seccomp <fd>`.
 *
 * Hand-assembled so the broker needs no libseccomp. Each instruction is a
 * `struct sock_filter { u16 code; u8 jt; u8 jf; u32 k; }`, little-endian.
 * Unknown architectures are killed outright; denied calls fail with EPERM.
 */

type SeccompArch = "x64" | "arm64";

const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const RET_K = 0x06;

const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const X32_SYSCALL_BIT = 0x40000000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050000 | 1;
const AF_UNIX = 1;
const AF_VSOCK = 40;

/** Offsets into `struct seccomp_data`. */
const NR_OFFSET = 0;
const ARCH_OFFSET = 4;
const ARG0_LOW_OFFSET = 16;

type Instruction = [code: number, jt: number, jf: number, k: number];

/**
 * Syscalls denied as [x86_64, aarch64] numbers.
 *
 * - ptrace, process_vm_readv/writev: cross-process reach into memory of other
 *   processes the sandbox can see.
 * - keyctl, add_key, request_key: kernel keyrings are not namespaced and can
 *   hold host credentials.
 * - bpf, perf_event_open, userfaultfd, io_uring_*: large kernel attack surface
 *   with a long exploit history and no legitimate use for tool commands.
 */
const DENIED: ReadonlyArray<readonly [name: string, x64: number, arm64: number]> = [
	["ptrace", 101, 117],
	["process_vm_readv", 310, 270],
	["process_vm_writev", 311, 271],
	["keyctl", 250, 219],
	["add_key", 248, 217],
	["request_key", 249, 218],
	["bpf", 321, 280],
	["perf_event_open", 298, 241],
	["userfaultfd", 323, 282],
	["io_uring_setup", 425, 425],
	["io_uring_enter", 426, 426],
	["io_uring_register", 427, 427],
];

const SOCKET_NR: Record<SeccompArch, number> = { x64: 41, arm64: 198 };

function archBlock(arch: SeccompArch): Instruction[] {
	const block: Instruction[] = [[LD_W_ABS, 0, 0, NR_OFFSET]];
	if (arch === "x64") {
		// Deny the x32 ABI: its syscall numbers would bypass the checks below.
		block.push([JGE_K, 0, 1, X32_SYSCALL_BIT], [RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM]);
	}
	for (const [, x64, arm64] of DENIED) {
		block.push([JEQ_K, 0, 1, arch === "x64" ? x64 : arm64], [RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM]);
	}
	// vsock reaches the WSL/VM host outside the network namespace. A unix
	// socket can connect to any filesystem socket in a bound directory, which
	// no network namespace isolates; socketpair stays allowed.
	block.push(
		[JEQ_K, 0, 4, SOCKET_NR[arch]],
		[LD_W_ABS, 0, 0, ARG0_LOW_OFFSET],
		[JEQ_K, 1, 0, AF_VSOCK],
		[JEQ_K, 0, 1, AF_UNIX],
		[RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM],
		[RET_K, 0, 0, SECCOMP_RET_ALLOW],
	);
	return block;
}

/** One filter for both supported architectures; any other is killed. */
export function seccompFilter(): Buffer {
	const x86 = archBlock("x64");
	const arm = archBlock("arm64");
	const program: Instruction[] = [
		[LD_W_ABS, 0, 0, ARCH_OFFSET],
		[JEQ_K, 0, x86.length, AUDIT_ARCH_X86_64],
		...x86,
		[JEQ_K, 0, arm.length, AUDIT_ARCH_AARCH64],
		...arm,
		[RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS],
	];
	const buffer = Buffer.alloc(program.length * 8);
	program.forEach(([code, jt, jf, k], index) => {
		const offset = index * 8;
		buffer.writeUInt16LE(code, offset);
		buffer.writeUInt8(jt, offset + 2);
		buffer.writeUInt8(jf, offset + 3);
		buffer.writeUInt32LE(k >>> 0, offset + 4);
	});
	return buffer;
}
