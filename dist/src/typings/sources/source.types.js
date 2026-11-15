/**
 * Type definitions for source worker
 * @module typings/source.types
 */
/**
 * Frame type identifier for socket communication protocol
 * @public
 */
export var FrameType;
(function (FrameType) {
    /** Data chunk frame (0) - contains payload data */
    FrameType[FrameType["DATA"] = 0] = "DATA";
    /** End frame (1) - signals completion of transmission */
    FrameType[FrameType["END"] = 1] = "END";
    /** Error frame (2) - contains error message */
    FrameType[FrameType["ERROR"] = 2] = "ERROR";
    /** Chat action frame (3) - contains live chat actions */
    FrameType[FrameType["CHAT_ACTION"] = 3] = "CHAT_ACTION";
    /** Binary result frame (4) - contains v8 serialized binary payload */
    FrameType[FrameType["BINARY"] = 4] = "BINARY";
    /** Hello frame (5) - worker handshake */
    FrameType[FrameType["HELLO"] = 5] = "HELLO";
    /** Task frame (6) - master to worker task dispatch */
    FrameType[FrameType["TASK"] = 6] = "TASK";
})(FrameType || (FrameType = {}));
