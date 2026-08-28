package com.local.mp4gif

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AiWhitelistTest {

    @Test
    fun acceptsValidCallList() {
        val raw = """[{"method":"open_page","params":{"page":"meme"}},{"method":"add_text","params":{"text":"哈哈"}}]"""
        val calls = AiWhitelist.parse(raw)
        assertNotNull(calls)
        assertEquals(2, calls!!.size)
        assertEquals("meme", calls[0].params.getString("page"))
    }

    @Test
    fun acceptsOptionalParams() {
        val raw = """[{"method":"apply_filter","params":{"preset":"gray"}}]"""
        assertNotNull(AiWhitelist.parse(raw))
    }

    @Test
    fun rejectsUnknownMethod() {
        val raw = """[{"method":"open_page","params":{"page":"home"}}]"""
        assertNull(AiWhitelist.parse(raw))
    }

    @Test
    fun rejectsExtraParam() {
        val raw = """[{"method":"import_source","params":{"path":"/tmp/a.gif"}}]"""
        assertNull(AiWhitelist.parse(raw))
    }

    @Test
    fun rejectsWrongType() {
        val raw = """[{"method":"set_text_size","params":{"size":"32"}}]"""
        assertNull(AiWhitelist.parse(raw))
    }

    @Test
    fun rejectsOutOfRange() {
        val raw = """[{"method":"set_text_size","params":{"size":200}}]"""
        assertNull(AiWhitelist.parse(raw))
    }

    @Test
    fun rejectsBadColor() {
        val raw = """[{"method":"set_text_color","params":{"color":"red"}}]"""
        assertNull(AiWhitelist.parse(raw))
    }

    @Test
    fun rejectsBadEnum() {
        val raw = """[{"method":"set_draw_mode","params":{"mode":"pencil"}}]"""
        assertNull(AiWhitelist.parse(raw))
    }

    @Test
    fun acceptsDrawLine() {
        val raw = """[{"method":"draw_line","params":{"x1":0,"y1":240,"x2":480,"y2":240,"color":"#FF0000","stroke_width":4}}]"""
        assertNotNull(AiWhitelist.parse(raw))
    }

    @Test
    fun acceptsLayerMove() {
        val raw = """[{"method":"select_layer","params":{"index":0}},{"method":"move_layer","params":{"x":240,"y":240}}]"""
        assertNotNull(AiWhitelist.parse(raw))
    }

    @Test
    fun rejectsAdvancedEditorMethod() {
        val raw = """[{"method":"open_advanced_editor","params":{}}]"""
        assertNull(AiWhitelist.parse(raw))
    }

    @Test
    fun rejectsAdvancedTool() {
        val raw = """[{"method":"set_tool","params":{"tool":"advanced"}}]"""
        assertNull(AiWhitelist.parse(raw))
    }

    @Test
    fun rejectsNonArrayOutput() {
        assertNull(AiWhitelist.parse("""{"method":"undo","params":{}}"""))
    }
}
