/*global Ultraviolet*/
// Velocity's Ultraviolet config — /uv/ prefix, bare v3 backend, xor codec.
self.__uv$config = {
	prefix: "/uv/",
	bare: location.origin + "/bare/",
	encodeUrl: Ultraviolet.codec.xor.encode,
	decodeUrl: Ultraviolet.codec.xor.decode,
	handler: "/uvfiles/uv.handler.js",
	client: "/uvfiles/uv.client.js",
	bundle: "/uvfiles/uv.bundle.js",
	config: "/uvfiles/uv.config.js",
	sw: "/uvfiles/uv.sw.js",
};
